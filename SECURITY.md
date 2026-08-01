# Security policy

`codemux` launches third-party coding agents and can grant them filesystem,
network, and credential access. Treat autonomy, environment forwarding, and
sandbox changes as security-sensitive.

## Trust boundaries

- Normalized autonomy is a best-effort translation of upstream CLI controls,
  not a security boundary. Use `--sandbox` whenever the task or repository is
  untrusted.
- `scode` is an external dependency and owns the sandbox boundary. Audit and
  update it independently; Codemux validates its executable and refuses
  repository-local policy files but cannot repair defects in the installed
  sandbox implementation.
- High autonomy intentionally permits broad tool access. Do not forward secrets
  that the selected harness or its tools do not need.
- Third-party harness behavior can change between versions. Run the installed
  contract suite before releases or harness upgrades.

## Supported versions

Until the project reaches a stable release, security fixes are applied to the
latest release and the `main` branch.

## Reporting a vulnerability

Please report suspected vulnerabilities privately to
[laurent@bindschaedler.com](mailto:laurent@bindschaedler.com). Include:

- affected version or commit;
- reproduction steps or a minimal proof of concept;
- expected and observed impact;
- any suggested mitigation.

Do not include credentials or other third-party secrets. Please avoid public
disclosure until the report has been reviewed and a remediation plan is ready.
