# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub private vulnerability reporting: open the repository's **Security**
tab and choose **Report a vulnerability**. That opens a private advisory visible only to the maintainer. Do not open
a public issue for security reports.

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | Yes (latest minor) |
| < 0.2   | No                 |

## Release integrity

Only the repository owner publishes this package. Releases are built from `.github/workflows/release.yml` on version
tags and published to npm through npm trusted publishing (OIDC) with staged approval: the owner approves the staged
version with `npm stage approve <stage-id>` plus two-factor authentication. npm tokens are disallowed for this
package, so a leaked token cannot publish.
