export default {
  root: '.',
  build: {
    outDir: 'dist'
  },
  server: {
    port: 5173,
    watch: {
      usePolling: false,
      ignored: ['**/node_modules/**', '**/.git/**']
    }
  }
};
