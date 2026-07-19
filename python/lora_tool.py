"""LoRA Lab backend: scan / analyze / clip krea2 (and generic) LoRA safetensors.

All subcommands print a single JSON object to stdout.
  scan <dir>            list safetensors files in dir (recursive, depth 3)
  analyze <file>        per-module spectral analysis + verdict
  clip <file> <cap>     write *_sclip<cap> copy with singular values capped
  traj <f1> <f2> ...    training-run trajectory: per-checkpoint stats + spectrogram
                        matrix + direction cosine between consecutive checkpoints.
                        Analyses and pair-cosines are disk-cached, so re-running on
                        a growing run only loads the new checkpoints.
  pick                  native folder picker (tkinter), returns {"dir": ...}
"""
import hashlib
import json
import os
import struct
import sys
from collections import defaultdict

import numpy as np


def _cache_dir():
    base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".cache")
    d = os.path.join(base, "LoRALab", "cache")
    os.makedirs(d, exist_ok=True)
    return d


def _cache_path(path, st):
    key = hashlib.sha1(f"{os.path.abspath(path)}|{int(st.st_mtime)}|{st.st_size}".encode()).hexdigest()
    return os.path.join(_cache_dir(), key + ".json")

HEALTHY_SMAX = 5.5
SPIKED_SMAX = 8.0


def read_header(path):
    with open(path, "rb") as f:
        (hlen,) = struct.unpack("<Q", f.read(8))
        h = json.loads(f.read(hlen))
    h.pop("__metadata__", None)
    return h, 8 + hlen


def load(path, info, base):
    start, end = info["data_offsets"]
    with open(path, "rb") as f:
        f.seek(base + start)
        raw = f.read(end - start)
    if info["dtype"] == "BF16":
        u = np.frombuffer(raw, dtype=np.uint16).astype(np.uint32) << 16
        a = u.view(np.float32).astype(np.float32)
    else:
        np_dtype = {"F32": np.float32, "F16": np.float16, "F64": np.float64}[info["dtype"]]
        a = np.frombuffer(raw, dtype=np_dtype).astype(np.float32)
    return a.reshape(info["shape"])


def collect_modules(header):
    lora = defaultdict(dict)
    lokr = defaultdict(dict)
    for k in header:
        if k.endswith(".lora_A.weight"):
            lora[k[: -len(".lora_A.weight")]]["A"] = k
        elif k.endswith(".lora_B.weight"):
            lora[k[: -len(".lora_B.weight")]]["B"] = k
        elif k.endswith(".lora_down.weight"):
            lora[k[: -len(".lora_down.weight")]]["A"] = k
        elif k.endswith(".lora_up.weight"):
            lora[k[: -len(".lora_up.weight")]]["B"] = k
        elif k.endswith(".alpha"):
            lora[k[: -len(".alpha")]]["alpha"] = k
            lokr[k[: -len(".alpha")]]["alpha"] = k
        elif k.endswith(".lokr_w1"):
            lokr[k[: -len(".lokr_w1")]]["w1"] = k
        elif k.endswith(".lokr_w2"):
            lokr[k[: -len(".lokr_w2")]]["w2"] = k
    lora = {m: p for m, p in lora.items() if "A" in p and "B" in p}
    lokr = {m: p for m, p in lokr.items() if "w1" in p and "w2" in p}
    return lora, lokr


def file_type(header):
    lora, lokr = collect_modules(header)
    if lokr:
        return "lokr"
    if lora:
        return "lora"
    return "other"


def as2d(t):
    return t.reshape(t.shape[0], -1) if t.ndim > 2 else t


def lora_sigmas(path, header, base, parts):
    A = as2d(load(path, header[parts["A"]], base))
    B = as2d(load(path, header[parts["B"]], base))
    rank = min(A.shape[0], B.shape[1]) if B.shape[1] == A.shape[0] else A.shape[0]
    Qb, Rb = np.linalg.qr(B)
    Qa, Ra = np.linalg.qr(A.T)
    s = np.linalg.svd(Rb @ Ra.T, compute_uv=False)
    alpha = None
    if "alpha" in parts:
        alpha = float(load(path, header[parts["alpha"]], base).reshape(-1)[0])
        if alpha < 1e6:  # ignore full-rank sentinel values
            s = s * (alpha / rank)
    return s, rank, alpha


def cmd_scan(directory):
    results = []
    base_depth = os.path.normpath(directory).count(os.sep)
    for root, dirs, files in os.walk(directory):
        if os.path.normpath(root).count(os.sep) - base_depth >= 3:
            dirs[:] = []
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fn in files:
            if not fn.lower().endswith(".safetensors"):
                continue
            full = os.path.join(root, fn)
            try:
                st = os.stat(full)
            except OSError:
                continue
            results.append({
                "name": fn,
                "path": full,
                "rel": os.path.relpath(full, directory),
                "dir": os.path.relpath(root, directory),
                "size": st.st_size,
                "mtime": int(st.st_mtime),
                "is_clip": "_sclip" in fn,
            })
    results.sort(key=lambda r: (r["dir"], -r["mtime"]))
    return {"dir": directory, "files": results}


def _sigma_max(W, iters=30, block=4, seed=0):
    """Top singular value via block power iteration — O(n^2) per step instead of
    the O(n^3) full SVD. Accurate to well under 1% for health-check purposes."""
    W = np.ascontiguousarray(W, dtype=np.float32)
    rng = np.random.default_rng(seed)
    V = rng.standard_normal((W.shape[1], block)).astype(np.float32)
    V, _ = np.linalg.qr(V)
    for _ in range(iters):
        V, _ = np.linalg.qr(W.T @ (W @ V))
    s = np.linalg.svd(W @ V, compute_uv=False)
    return float(s[0])


def cmd_analyze(path):
    st = os.stat(path)
    cpath = _cache_path(path, st)
    if os.path.exists(cpath):
        try:
            with open(cpath, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            pass

    header, base = read_header(path)
    lora, lokr = collect_modules(header)
    ftype = "lokr" if lokr else ("lora" if lora else "other")
    modules = []

    if ftype == "lora":
        for mod, parts in sorted(lora.items()):
            s, rank, alpha = lora_sigmas(path, header, base, parts)
            smax = float(s[0]) if len(s) else 0.0
            fro2 = float((s ** 2).sum())
            srank = fro2 / (smax ** 2) if smax > 0 else 0.0
            modules.append({"mod": mod, "smax": round(smax, 4), "srank": round(srank, 2),
                            "norm": round(fro2 ** 0.5, 4), "rank": int(rank)})
    elif ftype == "lokr":
        for mod, parts in sorted(lokr.items()):
            w1 = as2d(load(path, header[parts["w1"]], base))
            w2 = as2d(load(path, header[parts["w2"]], base))
            # kron identities: sigma_max factorizes, frobenius norm factorizes.
            # w1 is tiny (exact SVD); w2 only needs its top sigma (power iteration)
            # -- avoids a full O(n^3) SVD per module, which made big LoKrs crawl.
            s1max = float(np.linalg.svd(w1, compute_uv=False)[0])
            s2max = _sigma_max(w2)
            smax = s1max * s2max
            fro2 = float((w1.astype(np.float64) ** 2).sum() * (w2.astype(np.float64) ** 2).sum())
            srank = fro2 / (smax ** 2) if smax > 0 else 0.0
            modules.append({"mod": mod, "smax": round(smax, 4), "srank": round(srank, 2),
                            "norm": round(fro2 ** 0.5, 4), "rank": None})
    else:
        return {"path": path, "type": "other", "error": "No LoRA or LoKr modules found in this file."}

    smaxes = np.array([m["smax"] for m in modules])
    sranks = np.array([m["srank"] for m in modules])
    peak = float(smaxes.max()) if len(smaxes) else 0.0
    med_srank = float(np.median(sranks)) if len(sranks) else 0.0

    if peak <= HEALTHY_SMAX:
        verdict = "healthy"
    elif peak >= SPIKED_SMAX and med_srank < 3.0:
        verdict = "spiked"
    else:
        verdict = "borderline"

    result = {
        "path": path,
        "name": os.path.basename(path),
        "size": st.st_size,
        "mtime": int(st.st_mtime),
        "type": ftype,
        "verdict": verdict,
        "module_count": len(modules),
        "peak_smax": round(peak, 4),
        "mean_smax": round(float(smaxes.mean()), 4),
        "median_smax": round(float(np.median(smaxes)), 4),
        "median_srank": round(med_srank, 2),
        "mean_srank": round(float(sranks.mean()), 2),
        "total_norm": round(float(np.sqrt((np.array([m["norm"] for m in modules]) ** 2).sum())), 3),
        "over_cap_5": int((smaxes > 5.0).sum()),
        "over_cap_8": int((smaxes > 8.0).sum()),
        "modules": modules,
    }
    try:
        with open(cpath, "w", encoding="utf-8") as f:
            json.dump(result, f)
    except OSError:
        pass
    return result


def _pair_cache_path(p1, st1, p2, st2):
    key = hashlib.sha1(
        f"{os.path.abspath(p1)}|{int(st1.st_mtime)}|{st1.st_size}||"
        f"{os.path.abspath(p2)}|{int(st2.st_mtime)}|{st2.st_size}".encode()
    ).hexdigest()
    return os.path.join(_cache_dir(), "pair_" + key + ".json")


def _load_factors(path):
    """Load every adapter factor into memory (for cross-checkpoint comparison)."""
    header, base = read_header(path)
    lora, lokr = collect_modules(header)
    if lokr:
        out = {}
        for mod, parts in sorted(lokr.items()):
            out[mod] = (as2d(load(path, header[parts["w1"]], base)),
                        as2d(load(path, header[parts["w2"]], base)))
        return "lokr", out
    if lora:
        out = {}
        for mod, parts in sorted(lora.items()):
            A = as2d(load(path, header[parts["A"]], base))
            B = as2d(load(path, header[parts["B"]], base))
            scale = 1.0
            if "alpha" in parts:
                alpha = float(load(path, header[parts["alpha"]], base).reshape(-1)[0])
                if alpha < 1e6:
                    scale = alpha / A.shape[0]
            out[mod] = (A, B, scale)
        return "lora", out
    return "other", {}


def _pair_cos(t1, t2):
    """Global cosine between two checkpoints' full weight deltas.
    Never materializes the deltas: LoRA uses trace identities on the small
    factor products; LoKr uses <w1 kron w2, w1' kron w2'> = <w1,w1'><w2,w2'>."""
    ft1, f1 = t1
    ft2, f2 = t2
    if ft1 != ft2 or ft1 == "other":
        return None
    inner = n1 = n2 = 0.0
    for mod, x in f1.items():
        y = f2.get(mod)
        if y is None:
            continue
        if ft1 == "lokr":
            w1a, w2a = x
            w1b, w2b = y
            if w1a.shape != w1b.shape or w2a.shape != w2b.shape:
                continue
            inner += float((w1a * w1b).sum()) * float((w2a * w2b).sum())
            n1 += float((w1a ** 2).sum()) * float((w2a ** 2).sum())
            n2 += float((w1b ** 2).sum()) * float((w2b ** 2).sum())
        else:
            A1, B1, s1 = x
            A2, B2, s2 = y
            if A1.shape[1] != A2.shape[1] or B1.shape[0] != B2.shape[0]:
                continue
            inner += s1 * s2 * float(np.trace((B1.T @ B2) @ (A2 @ A1.T)))
            n1 += (s1 ** 2) * float(np.trace((B1.T @ B1) @ (A1 @ A1.T)))
            n2 += (s2 ** 2) * float(np.trace((B2.T @ B2) @ (A2 @ A2.T)))
    if n1 <= 0.0 or n2 <= 0.0:
        return None
    return inner / (n1 ** 0.5 * n2 ** 0.5)


def cmd_traj(paths):
    n = len(paths)
    if n < 2:
        return {"error": "need at least 2 checkpoints for a trajectory"}
    stats = [os.stat(p) for p in paths]
    pair_paths = [None] + [_pair_cache_path(paths[i - 1], stats[i - 1], paths[i], stats[i])
                           for i in range(1, n)]
    pair_cached = [True] + [os.path.exists(pp) for pp in pair_paths[1:]]
    need_factors = [False] * n
    for i in range(1, n):
        if not pair_cached[i]:
            need_factors[i - 1] = True
            need_factors[i] = True

    files, spectro = [], []
    cosines = [None] * n
    mod_order = None
    prev_factors = None
    for i, p in enumerate(paths):
        a = cmd_analyze(p)
        if "error" in a:
            return {"error": f"{os.path.basename(p)}: {a['error']}"}
        if mod_order is None:
            mod_order = [m["mod"] for m in a["modules"]]
        smap = {m["mod"]: m["smax"] for m in a["modules"]}
        spectro.append([smap.get(m, 0.0) for m in mod_order])
        files.append({k: a[k] for k in (
            "path", "name", "mtime", "type", "verdict", "module_count", "peak_smax",
            "mean_smax", "median_smax", "median_srank", "mean_srank", "total_norm", "over_cap_5")})

        cur_factors = _load_factors(p) if need_factors[i] else None
        if i > 0:
            if pair_cached[i]:
                try:
                    with open(pair_paths[i], encoding="utf-8") as f:
                        cosines[i] = json.load(f)["cos"]
                except (OSError, json.JSONDecodeError, KeyError):
                    cosines[i] = None
            elif prev_factors is not None and cur_factors is not None:
                c = _pair_cos(prev_factors, cur_factors)
                cosines[i] = None if c is None else round(c, 5)
                try:
                    with open(pair_paths[i], "w", encoding="utf-8") as f:
                        json.dump({"cos": cosines[i]}, f)
                except OSError:
                    pass
        prev_factors = cur_factors

    return {"files": files, "cosines": cosines, "mod_order": mod_order, "spectro": spectro}


def to_bf16_bytes(arr):
    f = np.ascontiguousarray(arr, dtype=np.float32)
    u = f.view(np.uint32)
    rounded = ((u + 0x7FFF + ((u >> 16) & 1)) >> 16).astype(np.uint16)
    nan_mask = np.isnan(f)
    if nan_mask.any():
        rounded[nan_mask] = 0x7FC0
    return rounded.tobytes()


def cmd_clip(path, cap):
    header, base = read_header(path)
    lora, lokr = collect_modules(header)
    if not lora:
        if lokr:
            return {"error": "This is a LoKr file - clipping is only implemented for plain LoRA (LoKr files are normally already healthy)."}
        return {"error": "No LoRA modules found in this file."}

    out_tensors = {}
    clipped = 0
    for mod, parts in sorted(lora.items()):
        A = load(path, header[parts["A"]], base)
        B = load(path, header[parts["B"]], base)
        a_shape, b_shape = A.shape, B.shape
        A2, B2 = as2d(A), as2d(B)
        Qb, Rb = np.linalg.qr(B2)
        Qa, Ra = np.linalg.qr(A2.T)
        U, s, Vt = np.linalg.svd(Rb @ Ra.T)
        if s[0] > cap:
            clipped += 1
        root = np.sqrt(np.minimum(s, cap))
        newB = (Qb @ U) * root[None, :]
        newA = (root[:, None] * Vt) @ Qa.T
        out_tensors[parts["B"]] = newB.reshape(b_shape)
        out_tensors[parts["A"]] = newA.reshape(a_shape)
        if "alpha" in parts:
            out_tensors[parts["alpha"]] = load(path, header[parts["alpha"]], base)

    cap_str = ("%g" % cap)
    dst = path[: -len(".safetensors")] + f"_sclip{cap_str}.safetensors" if path.endswith(".safetensors") else path + f"_sclip{cap_str}"
    new_header = {}
    offset = 0
    blobs = []
    for k in out_tensors:
        b = to_bf16_bytes(out_tensors[k])
        new_header[k] = {"dtype": "BF16", "shape": list(out_tensors[k].shape),
                         "data_offsets": [offset, offset + len(b)]}
        blobs.append(b)
        offset += len(b)
    hj = json.dumps(new_header).encode()
    with open(dst, "wb") as f:
        f.write(struct.pack("<Q", len(hj)))
        f.write(hj)
        for b in blobs:
            f.write(b)

    return {"src": path, "dst": dst, "cap": cap,
            "clipped_modules": clipped, "total_modules": len(lora),
            "result": cmd_analyze(dst)}


def cmd_pick():
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    d = filedialog.askdirectory(title="Choose LoRA folder")
    root.destroy()
    return {"dir": d or None}


def cmd_pickfile(title="Choose file"):
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    f = filedialog.askopenfilename(title=title)
    root.destroy()
    return {"file": f or None}


def main():
    cmd = sys.argv[1]
    if cmd == "scan":
        out = cmd_scan(sys.argv[2])
    elif cmd == "analyze":
        out = cmd_analyze(sys.argv[2])
    elif cmd == "clip":
        out = cmd_clip(sys.argv[2], float(sys.argv[3]))
    elif cmd == "traj":
        out = cmd_traj(sys.argv[2:])
    elif cmd == "pick":
        out = cmd_pick()
    elif cmd == "pickfile":
        out = cmd_pickfile(sys.argv[2] if len(sys.argv) > 2 else "Choose file")
    else:
        out = {"error": f"unknown command {cmd}"}
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stdout.write(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(0)
