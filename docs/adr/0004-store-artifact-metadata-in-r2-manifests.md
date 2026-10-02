# Store Artifact metadata in R2 manifests

Arty will store one private, versioned R2 manifest per Artifact and use its conditional creation as the commit point instead of provisioning D1. R2 already provides the required strong consistency, while D1 would add migrations and another Cloudflare-specific resource without solving the cross-service failure window; reconsider D1 when Arty needs metadata queries, multiple Publishers, identity-based sharing, or cleanup volume beyond practical manifest scans.
