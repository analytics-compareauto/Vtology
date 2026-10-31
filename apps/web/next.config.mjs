/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@vtology/core', '@vtology/server'],
  serverExternalPackages: ['postgres'],
};
export default nextConfig;
