# Host on Publisher-owned Cloudflare infrastructure

Arty will initially provision a Worker, private R2 bucket, and daily cleanup trigger in each Publisher's Cloudflare account rather than operate a central service. The Worker can deny access at the exact expiry while R2 stores static content and removes abandoned objects through a 35-day lifecycle backstop; this requires more setup than Cloudflare Pages but avoids Arty accounts, billing, abuse controls, and AWS's larger infrastructure footprint.
