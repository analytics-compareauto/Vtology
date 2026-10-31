/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@vtology/core', '@vtology/server'],
  serverExternalPackages: ['postgres', '@electric-sql/pglite'],
};
export default nextConfig;
