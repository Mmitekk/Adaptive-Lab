import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => {
  const pages = mode === 'pages';
  const repository = process.env.GITHUB_REPOSITORY || 'Mmitekk/Adaptive-Lab';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Некорректный GITHUB_REPOSITORY.');
  return {
    base: pages ? './' : '/',
    define: {
      __PAGES__: JSON.stringify(pages),
      __REPOSITORY__: JSON.stringify(repository),
    },
    build: { outDir: pages ? 'dist-pages' : 'dist' },
  };
});
