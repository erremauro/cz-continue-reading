# CZ Continue Reading

**CZ Continue Reading** è un plugin per WordPress che traccia il progresso di lettura degli articoli e permette agli utenti di visualizzare un elenco degli articoli in corso di lettura tramite uno shortcode/widget.

Funziona sia per **utenti loggati** che per **visitatori anonimi** (con salvataggio locale via `localStorage`).

---

## Funzionalità principali

- Tracciamento del progresso di lettura basato sullo **scroll verticale** (considerando la posizione centrale dello schermo).
- Stato degli articoli: **da leggere**, **in lettura**, **letto**.
- Sincronizzazione automatica: se un utente effettua il login e ha progressi salvati nel `localStorage`, questi vengono sincronizzati con il profilo utente.
- Supporto agli articoli **multi-pagina**: la percentuale mostrata riflette il contenuto complessivo.
- Possibilità di segnare manualmente un articolo come **letto/non letto** con lo shortcode `[mark_as_read]` o dal widget.
- Ripresa della lettura: cliccando dal widget, l’utente torna esattamente alla pagina e alla posizione in cui aveva lasciato.
- Shortcode `[readings]` per mostrare la lista degli articoli in corso di lettura.
- Gestione per ospiti: se non loggati, il widget mostra un invito a **registrarsi o loggarsi** per non perdere la cronologia.
- API REST personalizzate per aggiornare il progresso di lettura.
- **Toolbar flottante**: mini barra sempre disponibile durante la lettura, senza dover tornare in cima.
- **Dwell-per-decrease**: gli incrementi di progresso vengono salvati subito, i decrementi solo se l’utente resta fermo in alto per alcuni ms (per evitare falsi regressi).
- **No-save zone**: la parte alta della pagina è esclusa dal tracking, così lo scroll per accedere al menu non influisce sulla percentuale.

---

## Requisiti

- WordPress 6.0+
- PHP 7.4+
- Un tema compatibile (testato su tema custom **cigno-zen**)

---

## Installazione

1. Copiare la cartella `cz-continue-reading` dentro `wp-content/plugins/`.
2. Attivare il plugin da **Plugin > Plugin installati** in WordPress.
3. Aggiungere lo shortcode `[readings]` in una pagina (tipicamente in **homepage**) per mostrare gli articoli in corso di lettura.
4. Aggiungere lo shortcode `[mark_as_read]` dentro i template dei singoli articoli (o tramite editor Gutenberg) per consentire il toggle "Segna come letto".

---

## Shortcode disponibili

### `[readings limit="5"]`
Mostra un elenco degli articoli in corso di lettura.

- `limit`: numero massimo di articoli da mostrare (default: 5).

Output:
- Titolo con link all’ultima posizione letta (con parametro `?czcr_pos`).
- Percentuale di lettura complessiva.
- Pulsante "Segna come letto".

---

### `[mark_as_read]`
Mostra un pulsante toggle nell’articolo corrente:
- **Segna come letto**: blocca definitivamente l’articolo come completato.
- **Segna come da leggere**: riporta l’articolo in stato "in lettura" e riprende il tracciamento.

---

## Funzioni per sviluppatori / Filtri disponibili

Il plugin fornisce alcuni **hook** utili per personalizzare il comportamento:

### `czcr_allowed_post_types`
Definisce i tipi di post ammessi nel widget `[readings]`.

Esempio:
```php
// Solo articoli
add_filter( 'czcr_allowed_post_types', function( $types ) {
    return [ 'post' ];
});
```

### `czcr_excluded_post_ids`

```php
add_filter( 'czcr_excluded_post_ids', function( $ids ) {
    $ids[] = 123; // ID della pagina login
    return $ids;
});
```