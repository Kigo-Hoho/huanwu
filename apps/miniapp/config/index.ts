import { defineConfig, type UserConfigExport } from '@tarojs/cli';
import { resolve } from 'node:path';

const identityProvider = process.env.TARO_APP_IDENTITY_PROVIDER ?? 'taro';
const target = process.env.TARO_ENV ?? 'weapp';
const buildEnvironment =
  process.env.TARO_APP_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development';

if (!['taro', 'acceptance'].includes(identityProvider)) {
  throw new Error(`Unknown identity provider: ${identityProvider}`);
}
if (identityProvider === 'acceptance' && target !== 'h5') {
  throw new Error('The acceptance identity provider is available only for explicit H5 builds.');
}
if (identityProvider === 'acceptance' && buildEnvironment !== 'acceptance') {
  throw new Error(
    'The acceptance identity provider requires TARO_APP_ENVIRONMENT=acceptance and must never be used in production.',
  );
}

export default defineConfig<'webpack5'>(async (_merge, { command, mode }) => {
  const config: UserConfigExport<'webpack5'> = {
    projectName: 'barter-miniapp',
    date: '2026-09-22',
    designWidth: 750,
    deviceRatio: { 750: 1 },
    sourceRoot: 'src',
    outputRoot: 'dist',
    framework: 'react',
    compiler: 'webpack5',
    defineConstants: {
      __API_BASE_URL__: JSON.stringify(
        process.env.TARO_APP_API_BASE_URL ?? 'http://localhost:3000',
      ),
      __IDENTITY_PROVIDER__: JSON.stringify(identityProvider),
      __BUILD_ENVIRONMENT__: JSON.stringify(buildEnvironment),
      __TARO_TARGET__: JSON.stringify(target),
      __ACCEPTANCE_IDENTITY_CODE__: JSON.stringify(
        identityProvider === 'acceptance' ? 'e2e-customer-code' : '',
      ),
    },
    mini: {},
    h5: {
      publicPath: '/',
      staticDirectory: 'static',
      webpackChain(chain) {
        chain.resolve.modules
          .add(resolve(process.cwd(), 'node_modules'))
          .add(resolve(process.cwd(), '../../node_modules'));
        chain.performance.maxAssetSize(400_000).maxEntrypointSize(400_000);
      },
    },
  };

  if (process.env.NODE_ENV === 'development' && command === 'build') {
    config.env = { NODE_ENV: JSON.stringify(mode ?? 'development') };
  }
  return config;
});
