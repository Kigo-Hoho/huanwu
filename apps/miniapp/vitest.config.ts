import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const localModules = fileURLToPath(new URL('./node_modules/', import.meta.url));

export default defineConfig({
  define: {
    ENABLE_ADJACENT_HTML: 'false',
    ENABLE_CLONE_NODE: 'false',
    ENABLE_CONTAINS: 'false',
    ENABLE_INNER_HTML: 'false',
    ENABLE_MUTATION_OBSERVER: 'false',
    ENABLE_SIZE_APIS: 'false',
    ENABLE_TEMPLATE_CONTENT: 'false',
    DEPRECATED_ADAPTER_COMPONENT: 'false',
    EXTERNAL_CLASSES: 'false',
    SUPPORT_TARO_POLYFILL: 'false',
    TARO_ENV: JSON.stringify('h5'),
    TARO_PLATFORM: JSON.stringify('web'),
    __ACCEPTANCE_IDENTITY_CODE__: JSON.stringify('e2e-customer-code'),
  },
  resolve: {
    alias: [
      {
        find: /^@tarojs\/components$/,
        replacement: fileURLToPath(
          new URL('../../node_modules/@tarojs/components-react/dist/index.js', import.meta.url),
        ),
      },
      { find: /^react$/, replacement: `${localModules}react/index.js` },
      { find: /^react-dom$/, replacement: `${localModules}react-dom/index.js` },
      { find: /^react\/(.+)$/, replacement: `${localModules}react/$1` },
      { find: /^react-dom\/(.+)$/, replacement: `${localModules}react-dom/$1` },
    ],
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});
