# Security Policy

## Supported version

Only the latest code on the default branch is supported during the beta period.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature instead of opening a public issue. Include:

- the affected file and version;
- a minimal reproduction;
- the expected security boundary;
- whether any local CAPTCHA image, browsing data, or credential was exposed.

Do not include real credentials, cookies, personal data, or private CAPTCHA samples in a report. Please allow reasonable time for investigation before public disclosure.

## Security boundaries

- The OCR HTTP service is intended to bind only to `127.0.0.1`.
- The Chrome extension sends images only to `http://127.0.0.1:8765`.
- General website origins are not allowed to call the local service.
- Training samples and feedback are local data and are ignored by Git.
- Optional custom models are local-only unless their provenance and redistribution license are documented.
