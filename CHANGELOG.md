# Change Log

All notable changes to the "checkov" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),

## [1.2.0] - 2026-10-19

### Added

- Severity mappings are bundled with the extension, so findings show a severity on a first run without network access. Each release ships the latest mappings.
- Each folder of a multi-root workspace can set its own `frameworks`, `skipFrameworks`, `skipChecks` and `minimumSeverity`.
- `useBridgecrewIDs`, `certificate` and `noCertVerify` now appear in the Settings UI. They already worked when set in `settings.json`.
- Changing `checkovVersion` reinstalls Checkov. There is no need to run "Install or Update" by hand.

### Changed

- Cached results are keyed on everything that produced them: the file, the settings that affect results, the Checkov config files, the files in `externalChecksDir` and the Checkov installation. Changing any of them always causes a fresh scan. `clearCacheUponConfigUpdate` now only frees the space taken by old results.
- A check missing from the severity mappings shows the severity Checkov reported, instead of none.
- Changing `minimumSeverity` redraws findings from the cache instead of running Checkov again.
- Moving quickly between files only scans the file you stop on. Going back to a file that is still being scanned carries on with that scan instead of restarting it.
- Findings are not shown on a file with unsaved changes, because Checkov scans the saved file and the lines would not match. Save the file to scan it.
- "Refresh Severity Mappings" always downloads the mappings again, and only reports an update when they changed.
- Skip comments match the indentation of the block they go into.
- Setting titles and descriptions have been rewritten to be consistent and up to date.

### Fixed

- "Checkov severity mappings updated" was shown every hour even when nothing had changed.
- Changing `useBridgecrewIDs`, `externalChecksDir`, `certificate` or `noCertVerify` kept serving results from before the change.
- After a Checkov upgrade, another workspace could keep serving results from the old version.
- A cancelled Docker scan could keep running in the background.
- Scans failed when Checkov printed log lines before its JSON output or a notice after it.
- Editing a file while it was being scanned could put findings on the wrong lines.
- A quick fix applied from the Problems panel cleared the findings of the active file instead of the file that was fixed.
- Two identical findings in one file shared a single fix.
- Quick fixes failed for a finding about the whole file.
- "Learn more" was offered for checks whose guideline is not a web link, and opened nothing.
- Correcting an invalid `checkovVersion` did nothing until Checkov was reinstalled by hand, and a version change made during an install was lost.
- The status bar could stay on "scanning" after a scan was cancelled.

## [1.1.0] - 2026-10-12

### Security

- Scans no longer run through a shell. File names, workspace paths and settings are passed to Checkov and Docker as separate arguments, so they can no longer be interpreted as commands.
- Docker mounts are now read-only. A file outside the workspace is mounted on its own instead of exposing its parent directory to the container.
- A workspace can only set `externalChecksDir` to an existing directory inside the workspace folder. Any other location, and the `certificate` and `noCertVerify` options, must be set in user settings.
- Helper commands such as `git` and `docker` no longer run with the workspace as their working directory, so on Windows a program of the same name inside a repository is not picked up.
- The extension now declares that it does not run in untrusted workspaces.
- Removed the `dockerode` dependency, which clears all open dependency advisories and cuts the packaged dependencies from 100 to 32.

### Added

- `.checkov.yaml` and `.checkov.yml` are now found in the scanned file's directory or any parent up to the workspace folder, nearest first. As on the command line, Checkov also applies the config in the workspace folder root. Each folder of a multi-root workspace uses its own config. (#26, thanks @ea-mtenhoor for the original PR)
- `skipPaths` setting: glob patterns for files that should not be scanned, for example `**/*.md`. (#27)
- `minimumSeverity` setting: only show findings at or above a severity. Findings with an unknown severity are always shown and the status bar shows when findings are hidden. (#25)
- `dockerSelinux` setting for hosts that enforce SELinux. (#29)

### Changed

- Files outside a workspace folder are scanned without a config file.
- Changes to a config file made outside VS Code now invalidate cached results.
- `skipChecks` accepts commas or spaces between check IDs, as documented.
- Paths in settings are passed to Checkov as written. Shell forms such as `$HOME` or `%USERPROFILE%` are no longer expanded, so use full paths.
- A relative `externalChecksDir` is resolved against the workspace folder.

### Fixed

- The extension version reported to Checkov and in "About Checkov" was always "unknown".
- On Windows, Checkov installed in a path containing spaces could not be located.

## [1.0.118] - 2025-07-19

### Added

- New GitHub-based severity provider system that automatically fetches and caches severity mappings from [XargsUK/checkov-severity-mapper](https://github.com/XargsUK/checkov-severity-mapper/). You will now see severities in the findings from Checkov!
- Background update checking for severity mappings.

### Fixed

- Fixed config file path quoting for pip installations (thanks @gabrielsjoberg)

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
