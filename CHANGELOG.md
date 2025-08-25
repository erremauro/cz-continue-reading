# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] 2025-08-25
### Added
- Add a javascript console debug utility via parameter `?czcr_debug=1`
### Changed
- Removed reading position (`czcr_pos`) from readings shortcode urls (the functionality is still working, though). Instead a "continue reading" pop-up message shows up whenever an article for which ready is in progress is opened.
### Fixed
- Fix a bug that caculated a 100% reading on opening for single-page posts.

## [1.2.1] 2025-08-22
### Changed
- The toolbar now appear as soon as the menu header disappear from view
- Remove label and update color scheme for toolbar's icon
### Fixed
- Fix wrong reading overall percent calculation for not logged-in users

## [1.2.0] 2025-08-21
### Changed
- Update the Toolbar appearance.
- Update the message informing about reading list storage capabilities for not logged-in users.
### Fixed
- Fix item list closing mark behavior when all items were removed
- Fix no-item visibility for not logged-in users.
- Fix login message typo in `czcr.js`

## [1.1.0] 2025-08-20
### Added
- Initial Commit


[Unreleased]: https://github.com/erremauro/cz-continue-reading/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.2.1
[1.2.0]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.2.0
[1.1.0]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.1.0
