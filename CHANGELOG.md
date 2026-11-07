# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] 2026-11-05
### Removed
- Toolbar flottante (Home, Su, Stampa), shortcode `[czcr_toolbar]`, filtro `czcr_auto_toolbar` e asset `assets/css/czcr-toolbar.css`: la toolbar è ora di cz-core (`mu-plugins/cz-toolbar`, `.cz-toolbar`), con la stessa resa e gli stessi pulsanti. L'evento `czcr:print` è sostituito da `cz-toolbar:print`.
- Stringhe `toolbar_home` e `toolbar_top` da `window.CZCR.i18n`.

## [1.10.0] 2026-11-05
### Added
- Pulsante "Stampa" (icona stampante) nella toolbar flottante, a destra di "Su"; attributo `show_print` dello shortcode `[czcr_toolbar]` (default `1`). Il click emette l'evento annullabile `czcr:print` su `document`: se nessuno lo annulla parte `window.print()`, così il tema può gestire casi particolari (es. post paginati).
- Regola `@media print` che nasconde la toolbar.
### Changed
- "Su" e "Stampa" sono raggruppati in `.czcr-toolbar__group`, dove altri plugin possono aggiungere pulsanti (cz-outline 1.1.0 vi inserisce l'icona dell'indice a sinistra di "Su").
- Su mobile (< 768px) il gruppo è centrato nella toolbar, con "Home" a sinistra e gli eventuali pulsanti aggiunti da altri plugin (segnalibro, evidenziatore) a destra.

## [1.9.2] 2026-06-12
### Added
- `uninstall.php` — removes `_czcr_progress_v1` usermeta from all users on plugin removal.
### Changed
- Aligned internal `VERSION` constant with plugin header (was `1.1.0`, now `1.9.2`).
- Updated author metadata to Roberto Mauro.

## [1.9.1] 2026-05-31
### Fixed
- Fix 'mark all as read' button padding values.

## [1.9.0] 2026-05-31
### Changed
- An article is now marked as 'read' if it has reached at least 98% of the total
### Added
- Add a "mark all as read" button for the `[reading]` shortcode

## [1.8.0] 2026-02-11
### Changed
- Disable continue-reading tracking and related actions for posts where user preferences `czup_continue_reading` is set to false.

## [1.7.0] 2026-01-30
### Changed
- Disable the plug-in if 'cr=disabled' query param is specified in the URL

## [1.5.2] 2025-12-29
### Changed
- Refine bottom nav border and blur

## [1.5.1] 2025-12-29
### Changed
- Styles has been updated to be more inline with current iphone UI trend.
### Fixed
- Popup dialog max-width and title font size has been changed for better fitting mobiles.

## [1.5.0] 2025-09-05
### Changed
- Applies class `czcr-reading-empty` or `czcr-readings-has` to `body` based on
base on the reading queue status.

## [1.4.1] 2025-08-30
### Changed
- Update all colors to RGBa
### Fixed
- Fix an HTML entity bug in the continue-reading card title
- Fix missing override for preferred color scheme

## [1.4.0] 2025-08-28
### Added
- Add support for dark/light theme

## [1.3.1] 2025-08-27
### Added
- Add a build script to minify javascript and css
### Changed
- Update style for empty reading queue message (`.czcr-empty`)
### Fixed
- Fix a bug that requested to continue from last position even intra-post on
page change.

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


[Unreleased]: https://github.com/erremauro/cz-continue-reading/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/erremauro/cz-continue-reading/releases/tag/v2.0.0
[1.9.2]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.9.2
[1.9.1]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.9.1
[1.9.0]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.9.0
[1.8.0]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.8.0
[1.7.0]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.7.0
[1.5.2]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.5.2
[1.5.1]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.5.1
[1.5.0]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.5.0
[1.4.1]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.4.1
[1.4.0]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.4.0
[1.3.1]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.3.1
[1.3.0]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.3.0
[1.2.1]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.2.1
[1.2.0]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.2.0
[1.1.0]: https://github.com/erremauro/cz-continue-reading/releases/tag/v1.1.0
