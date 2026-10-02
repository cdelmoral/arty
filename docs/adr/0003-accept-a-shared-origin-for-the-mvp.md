# Accept a shared origin for the MVP

Artifacts in one Provider account will use unguessable paths on a shared Worker hostname, so they are not browser security boundaries and may share cookies or browser storage. Per-Artifact origins would require a custom wildcard domain or separate Worker deployments, adding setup and operational limits that are not justified for the personal MVP; Publishers must therefore use trusted Sources until optional wildcard-domain isolation is supported.
