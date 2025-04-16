# Change Log

All notable changes to the "checkov" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),

## [1.0.117] - 2024-04-16

### Added
- Enhanced scan management system with:
  - Document-specific scan tracking and cancellation
  - Configurable limit for concurrent scans through new `maximumConcurrentScans` setting
  - Automatic scan timeout with configurable duration via new `scanTimeout` setting
  - Intelligent cleanup of completed scans to optimise resource usage
- Improved cancellation logic when switching between files
- Added detailed logging for scan lifecycle events

### Changed
- Reduced scan debounce time from 300ms to 100ms for more responsive scanning
- Optimised resource handling for better performance on multi-file projects

## [1.0.106] - 2024-03-31

### Fixed
- Windows python3 executable issue (#2)
- Commands not working
- Updated follow-redirects, minimatch and nanoid dependencies to fix security vulnerabilities: [CVE-2024-28849](https://github.com/advisories/GHSA-cxjh-pqwp-8mfp) / [CVE-2022-25883](https://github.com/advisories/GHSA-c2qf-rxjj-qqgw) / [CVE-2021-23566](https://github.com/advisories/GHSA-qrpm-p2h7-hrv2)

### Changed
- vscode-test package changed to @vscode/test-electron

### Removed
- Axios is now unused and has been removed. The version of axios used in the original extension was vulnerable to a high severity security issue [CVE-2023-45857](https://github.com/advisories/GHSA-wf5p-g6vw-rhxx).

## [1.0.105] - 2024-03-30

### Changed

- Logo and icon for the extension in the marketplace to include alpha channel.
- Help URL to point to the correct GitHub repository.
- README.md updated for consistency, and added a section on why the fork was created.

