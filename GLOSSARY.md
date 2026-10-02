# Arty

Arty temporarily puts static Sources on the web as Artifacts so people and agents can inspect them from elsewhere.

## Language

**Publisher**:
The person who uses the CLI to create and manage Artifacts through a Provider account they control.
_Avoid_: User, owner

**Viewer**:
A person or agent that accesses an Artifact through its Access URL.
_Avoid_: User, visitor

**Source**:
A local HTML file or directory containing a static site that is selected for publishing.
_Avoid_: Artifact, input, content

**Artifact**:
One remotely hosted, immutable copy of a Source. Each Artifact has its own unguessable URL and expires after its lifetime.
_Avoid_: Glimpse, publication, deployment, upload

**Publish**:
Create an Artifact from a Source.
_Avoid_: Deploy, upload

**Access URL**:
The unguessable URL through which Viewers access an Artifact. Possession of the URL grants access until expiry or deletion.
_Avoid_: Public URL, share link

**Lifetime**:
The requested duration for which an Artifact remains accessible, beginning when the Artifact is created.
_Avoid_: TTL, retention period

**Expiry**:
The point after which an Artifact is no longer accessible and becomes eligible for deletion.
_Avoid_: Deactivation

**Deletion**:
The permanent removal of an Artifact. A Publisher may request deletion before expiry; access ends immediately even if stored files are removed later.
_Avoid_: Revocation

**Provider**:
The external platform that stores and serves Artifacts using infrastructure and credentials owned by the Publisher.
_Avoid_: Backend, host
