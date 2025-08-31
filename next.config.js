// next.config.js
/** @type {import('next').NextConfig} */

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // HSTS (only if you’re on HTTPS — you are on Vercel)
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
];

const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,

  // Serve robots.txt and sitemap.xml from API routes
  async rewrites() {
    return [
      { source: '/robots.txt',  destination: '/api/robots'  },
      { source: '/sitemap.xml', destination: '/api/sitemap' },
    ];
  },

  // Helpful redirects
  async redirects() {
    return [
      // Clean up /index.html to /
      { source: '/index.html', destination: '/', permanent: true },

      // Backup host redirect in-app (Vercel domain redirect is primary)
      {
        source: '/:path*',
        has: [{ type: 'host', value: 'www.trytruetrend.com' }],
        destination: 'https://trytruetrend.com/:path*',
        permanent: true,
      },
    ];
  },

  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
    ];
  },
};

module.exports = nextConfig;
