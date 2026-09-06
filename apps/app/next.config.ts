import type { NextConfig } from 'next'

const config: NextConfig = {
  // Built into a container and served behind the same nginx as the rest of helico.site.
  output: 'standalone',
  reactStrictMode: true,
  transpilePackages: ['streamdown'],
}

export default config
