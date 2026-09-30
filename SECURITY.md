# Security Policy

Report vulnerabilities affecting Nila's application, native integration, data handling, IPC, imports, or packaging.

Nila should not expose:
- arbitrary shell execution
- unrestricted native filesystem APIs
- remote code loading
- unsafe imported content

Validate IPC and imported JSON carefully.
