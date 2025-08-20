<?php
/**
 * Plugin Name: CZ Continue Reading
 * Description: Tracks article reading progress (guests via localStorage, users via usermeta) and provides shortcodes: [readings] and [mark_as_read].
 * Version:     1.1.0
 * Author:      CZ
 * Text Domain: cz-continue-reading
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'CZCR_PLUGIN_PATH', plugin_dir_path( __FILE__ ) );

final class CZ_Continue_Reading {
	const VERSION           = '1.1.0';
	const SLUG              = 'cz-continue-reading';
	const REST_NAMESPACE    = 'czcr/v1';
	const USERMETA_KEY      = '_czcr_progress_v1'; // array keyed by post_id
	const LS_STORAGE_KEY    = 'czcr_progress_v1';  // for reference in JS

	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		add_action( 'init', [ $this, 'register_shortcodes' ] );
		add_action( 'wp_enqueue_scripts', [ $this, 'enqueue_assets' ] );
		add_action( 'rest_api_init', [ $this, 'register_rest_routes' ] );
		add_action( 'wp_footer', [ $this, 'maybe_print_toolbar' ] );
	}

	public function maybe_print_toolbar() {
		// Mostra solo nei singoli articoli (non in home, pagine, archivi, ecc.)
		if ( ! is_singular( 'post' ) ) {
			return;
		}

		$enabled = apply_filters( 'czcr_auto_toolbar', true );
		if ( ! $enabled ) {
			return;
		}

		echo $this->shortcode_toolbar( [
			'position'  => 'right',
			'show_home' => '1',
			'show_top'  => '1',
		] );
	}

	/** ---------------- Enqueue ---------------- */

	public function enqueue_assets() {
		$asset_url  = plugins_url( 'assets/js/czcr.js', __FILE__ );
		$asset_path = plugin_dir_path( __FILE__ ) . 'assets/js/czcr.js';

		wp_register_script(
			'czcr-js',
			$asset_url,
			[],
			file_exists( $asset_path ) ? filemtime( $asset_path ) : self::VERSION,
			true
		);

		$config = [
			'version'         => self::VERSION,
			'rest'            => [
				'root'   => esc_url_raw( trailingslashit( rest_url( self::REST_NAMESPACE ) ) ),
				'nonce'  => is_user_logged_in() ? wp_create_nonce( 'wp_rest' ) : null,
			],
			'user'            => [
				'loggedIn' => is_user_logged_in(),
				'id'       => get_current_user_id(),
			],
			'urls'            => [
				'login'       => wp_login_url(),
				'register'    => wp_registration_url(),
				'home'        => home_url( '/' ),
			],
			'i18n'           => [
				'mark_as_read'          => __( 'Segna come letto', 'cz-continue-reading' ),
				'mark_as_unread'        => __( 'Segna come da leggere', 'cz-continue-reading' ),
				'login_to_keep_history' => __( 'Accedi oppure registrati per non perdere la cronologia di lettura.', 'cz-continue-reading' ),
				'no_items'              => __( 'Nessun articolo in lettura.', 'cz-continue-reading' ),
				'percent'               => __( '%', 'cz-continue-reading' ),
				'toolbar_home'          => __( 'Home', 'cz-continue-reading' ),
				'toolbar_top'           => __( 'Su', 'cz-continue-reading' ),
			],
			'selectors'       => [
				'footnotes'       => 'div.footnotes',
				'postPagination'  => 'div.post-pagination',
				'postFooter'      => 'div.post-footer',
			],
			'storageKey'      => self::LS_STORAGE_KEY,
			'saveStep'        => 1,
			'throttleMs'      => 300,

			// NEW: tuning per “dwell-per-decrease” e “no-save zone”
			'decreaseDwellMs' => 1200,  // tempo minimo in ms in cui restare nella posizione “più su” prima di salvare un decremento
			'topNoSaveRatio'  => 0.15,  // fascia top (15% dell'articolo) dove i decrementi vengono ignorati se hai già superato un certo punto
			'peakGuardRatio'  => 0.50,  // dopo aver superato il 50% consideriamo “peak mode” per applicare la no-save zone

			'post'            => $this->localize_post_context(),
		];

		wp_enqueue_script( 'czcr-js' );
		wp_add_inline_script( 'czcr-js', 'window.CZCR = ' . wp_json_encode( $config ) . ';', 'before' );
		wp_enqueue_style(
			'czcr',
			plugins_url( 'assets/css/czcr.css', __FILE__ ),
			[],
			file_exists( plugin_dir_path( __FILE__ ) . 'assets/css/czcr.css' ) ? filemtime( plugin_dir_path( __FILE__ ) . 'assets/css/czcr.css' ) : self::VERSION
		);
		wp_enqueue_style(
			'czcr-toolbar',
			plugins_url( 'assets/css/czcr-toolbar.css', __FILE__ ),
			[],
			file_exists( plugin_dir_path( __FILE__ ) . 'assets/css/czcr-toolbar.css' ) ? filemtime( plugin_dir_path( __FILE__ ) . 'assets/css/czcr-toolbar.css' ) : self::VERSION
		);
	}

	private function localize_post_context() {
		if ( ! is_singular() ) {
			return null;
		}
		global $post;
		if ( ! $post instanceof WP_Post ) {
			return null;
		}

		$current_page = max( 1, intval( get_query_var( 'page' ) ) );
		if ( 0 === $current_page ) {
			$current_page = 1;
		}
		$content    = (string) $post->post_content;
		$totalPages = 1 + substr_count( $content, '<!--nextpage-->' );

		return [
			'id'          => (int) $post->ID,
			'permalink'   => get_permalink( $post ),
			'title'       => html_entity_decode( get_the_title( $post ), ENT_QUOTES ),
			'currentPage' => (int) $current_page,
			'totalPages'  => (int) max( 1, $totalPages ),
		];
	}

	/** ---------------- Shortcodes ---------------- */

	public function register_shortcodes() {
		add_shortcode( 'mark_as_read', [ $this, 'shortcode_mark_as_read' ] );
		add_shortcode( 'readings', [ $this, 'shortcode_readings' ] );
		add_shortcode( 'czcr_toolbar', [ $this, 'shortcode_toolbar' ] );
	}

	public function shortcode_mark_as_read( $atts = [] ) {
		if ( ! is_singular() ) {
			return '';
		}
		global $post;
		if ( ! $post instanceof WP_Post ) {
			return '';
		}
		$post_id = (int) $post->ID;

		$locked_done = false;
		if ( is_user_logged_in() ) {
			$data = $this->get_user_progress( get_current_user_id() );
			if ( isset( $data[ $post_id ] ) && isset( $data[ $post_id ]['status'] ) && 'locked_done' === $data[ $post_id ]['status'] ) {
				$locked_done = true;
			}
		}

		$label = $locked_done ? __( 'Segna come da leggere', 'cz-continue-reading' ) : __( 'Segna come letto', 'cz-continue-reading' );

		ob_start();
		?>
		<div class="czcr-mark-wrap" data-czcr-mark data-post-id="<?php echo esc_attr( $post_id ); ?>">
			<button type="button" class="czcr-mark-btn" aria-pressed="<?php echo $locked_done ? 'true' : 'false'; ?>">
				<span class="czcr-mark-label"><?php echo esc_html( $label ); ?></span>
			</button>
		</div>
		<?php
		return (string) ob_get_clean();
	}

	public function shortcode_toolbar( $atts = [] ) {
		// Blocca la render se non siamo in un singolo articolo
		if ( ! is_singular( 'post' ) ) {
			return '';
		}

		$atts = shortcode_atts(
			[
				'position'  => 'right',
				'show_home' => '1',
				'show_top'  => '1',
			],
			$atts,
			'czcr_toolbar'
		);

		$pos = ( $atts['position'] === 'left' ) ? 'left' : 'right';
		$show_home = ( $atts['show_home'] === '1' );
		$show_top  = ( $atts['show_top']  === '1' );

		ob_start(); ?>
		<div class="czcr-toolbar czcr-toolbar--<?php echo esc_attr( $pos ); ?>" aria-hidden="true">
			<?php if ( $show_home ) : ?>
				<button type="button" class="czcr-toolbar__btn" data-czcr-home><?php echo esc_html( __( 'Home', 'cz-continue-reading' ) ); ?></button>
			<?php endif; ?>
			<?php if ( $show_top ) : ?>
				<button type="button" class="czcr-toolbar__btn" data-czcr-top><?php echo esc_html( __( 'Su', 'cz-continue-reading' ) ); ?></button>
			<?php endif; ?>
		</div>
		<?php return (string) ob_get_clean();
	}

	/**
	 * [readings limit="5"]
	 * Links include page and position as shareable deep-links:
	 *   /post/3/?czcr_pos=72
	 */
	public function shortcode_readings( $atts = [] ) {
		$atts = shortcode_atts(
			[
				'limit' => 5,
			],
			$atts,
			'readings'
		);
		$limit = max( 1, (int) $atts['limit'] );

		ob_start();
		?>
		<div class="czcr-readings" data-czcr-readings data-limit="<?php echo esc_attr( $limit ); ?>">
			<?php
			if ( is_user_logged_in() ) {
				$user_id = get_current_user_id();
				$data    = $this->get_user_progress( $user_id );

				// Tipi di post consentiti ed ID esclusi (personalizzabili dal tema/plugin)
				$allowed_types = apply_filters( 'czcr_allowed_post_types', [ 'post' ] );
				$excluded_ids  = apply_filters( 'czcr_excluded_post_ids', [] );

				$items = [];
				foreach ( $data as $pid => $entry ) {
					if ( ! is_array( $entry ) ) {
						continue;
					}

					$pid = (int) $pid;

					// Escludi ID specifici
					if ( in_array( $pid, $excluded_ids, true ) ) {
						continue;
					}

					// Verifica esistenza post e tipo consentito
					$post = get_post( $pid );
					if ( ! $post || ! in_array( $post->post_type, (array) $allowed_types, true ) ) {
						continue;
					}

					$status  = isset( $entry['status'] ) ? $entry['status'] : 'reading';
					$overall = isset( $entry['percent_overall'] ) ? (float) $entry['percent_overall'] : 0.0;

					// Mostra solo "in lettura" (0<%<100) e non locked
					if ( 'locked_done' === $status || $overall <= 0 || $overall >= 100 ) {
						continue;
					}

					$last_page   = isset( $entry['last_page'] ) ? (int) $entry['last_page'] : 1;
					$total_pages = isset( $entry['total_pages'] ) ? (int) $entry['total_pages'] : 1;
					$pages_map   = ( isset( $entry['pages'] ) && is_array( $entry['pages'] ) ) ? $entry['pages'] : [];
					$page_pct    = isset( $pages_map[ $last_page ] ) ? (float) $pages_map[ $last_page ] : 0.0;

					// Link alla pagina corretta + deep-link della posizione (shareable)
					$base     = trailingslashit( get_permalink( $pid ) );
					$page_url = ( $last_page > 1 ) ? trailingslashit( $base . $last_page ) : $base;
					$page_url = add_query_arg( 'czcr_pos', max( 0, min( 100, round( $page_pct ) ) ), $page_url );

					$items[ $pid ] = [
						'post_id'     => $pid,
						'title'       => get_the_title( $pid ),
						'url'         => $page_url,
						'overall_pct' => max( 0, min( 100, round( $overall ) ) ),
					];
				}

				if ( empty( $items ) ) {
					echo '<p class="czcr-empty">' . esc_html__( 'Nessun articolo in lettura.', 'cz-continue-reading' ) . '</p>';
				} else {
					$count = 0;
					echo '<ul class="czcr-list">';
					foreach ( $items as $meta ) {
						if ( empty( $meta['title'] ) || empty( $meta['url'] ) ) {
							continue;
						}
						$count++;
						printf(
							'<li class="czcr-item" data-post-id="%1$d"><div class="czcr-top"><a class="czcr-link" href="%2$s">%3$s</a></div><div class="czcr-bottom"><span class="czcr-percent">%4$d%%</span> <button type="button" class="czcr-list-mark">%5$s</button></div></li>',
							(int) $meta['post_id'],
							esc_url( $meta['url'] ),
							esc_html( $meta['title'] ),
							(int) $meta['overall_pct'],
							esc_html__( 'Segna come letto', 'cz-continue-reading' )
						);
						if ( $count >= $limit ) {
							break;
						}
					}
					echo '</ul>';
				}
			} else {
				echo '<p class="czcr-guest-msg" data-czcr-guest-msg>'
					. sprintf(
						'%s <a href="%s">%s</a> %s <a href="%s">%s</a>.',
						esc_html__( 'Accedi', 'cz-continue-reading' ),
						esc_url( wp_login_url() ),
						esc_html__( 'Accedi', 'cz-continue-reading' ),
						esc_html__( 'oppure', 'cz-continue-reading' ),
						esc_url( wp_registration_url() ),
						esc_html__( 'registrati', 'cz-continue-reading' )
					)
					. '</p>';
			}
			?>
		</div>
		<?php
		return (string) ob_get_clean();
	}


	/** ---------------- REST API ---------------- */

	public function register_rest_routes() {
		register_rest_route(
			self::REST_NAMESPACE,
			'/progress',
			[
				'methods'             => WP_REST_Server::READABLE,
				'permission_callback' => function () { return is_user_logged_in(); },
				'callback'            => function () {
					$user_id = get_current_user_id();
					return rest_ensure_response( $this->get_user_progress( $user_id ) );
				},
			]
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/progress',
			[
				'methods'             => WP_REST_Server::CREATABLE,
				'permission_callback' => function () { return is_user_logged_in(); },
				'callback'            => function ( WP_REST_Request $req ) {
					$user_id    = get_current_user_id();
					$body       = $req->get_json_params();

					$post_id    = isset( $body['post_id'] ) ? intval( $body['post_id'] ) : 0;
					if ( $post_id <= 0 ) return new WP_Error( 'czcr_bad_post', 'Invalid post_id', [ 'status' => 400 ] );

					// PRE: $body = $req->get_json_params();
					$pages_in = ( isset( $body['pages'] ) && is_array( $body['pages'] ) ) ? $body['pages'] : [];

					// Preserve numeric keys (page numbers) and normalize to float 0..100
					$pages = [];
					foreach ( $pages_in as $k => $v ) {
						$i = intval( $k );
						if ( $i < 1 ) { continue; }
						$pages[ $i ] = floatval( $v );
					}

					$last_page  = isset( $body['last_page'] ) ? max( 1, intval( $body['last_page'] ) ) : 1;
					$total      = isset( $body['total_pages'] ) ? max( 1, intval( $body['total_pages'] ) ) : 1;
					$status     = isset( $body['status'] ) ? sanitize_key( $body['status'] ) : 'reading';
					$locked     = ( 'locked_done' === $status );

					// Build normalized pages 1..$total
					$norm_pages = [];
					for ( $i = 1; $i <= $total; $i++ ) {
						$val = isset( $pages[ $i ] ) ? (float) $pages[ $i ] : 0.0;
						$norm_pages[ $i ] = max( 0.0, min( 100.0, $val ) );
					}

					// Fill-forward: tutte le pagine < last_page valgono 100% se non già tali
					for ( $i = 1; $i < $last_page; $i++ ) {
						if ( ! isset( $norm_pages[ $i ] ) || $norm_pages[ $i ] < 100.0 ) {
							$norm_pages[ $i ] = 100.0;
						}
					}

					$percent_overall = $this->compute_overall_percent( $norm_pages, $total );
					if ( $locked ) {
						$percent_overall = 100.0;
					}

					$record = [
						'post_id'         => $post_id,
						'pages'           => $norm_pages,
						'last_page'       => min( $last_page, $total ),
						'total_pages'     => $total,
						'percent_overall' => $percent_overall,
						'status'          => $locked ? 'locked_done' : 'reading',
						'updated_at'      => current_time( 'mysql', true ),
					];

					$data             = $this->get_user_progress( $user_id );
					$data[ $post_id ] = $record;
					update_user_meta( $user_id, self::USERMETA_KEY, $data );

					return rest_ensure_response( $record );
				},
				'args'                => [
					'post_id'     => [ 'required' => true ],
				],
			]
		);

		register_rest_route(
			self::REST_NAMESPACE,
			'/mark',
			[
				'methods'             => WP_REST_Server::CREATABLE,
				'permission_callback' => function () { return is_user_logged_in(); },
				'callback'            => function ( WP_REST_Request $req ) {
					$user_id  = get_current_user_id();
					$params   = $req->get_json_params();
					$post_id  = isset( $params['post_id'] ) ? intval( $params['post_id'] ) : 0;
					$locked   = ! empty( $params['locked'] );
					if ( $post_id <= 0 ) return new WP_Error( 'czcr_bad_post', 'Invalid post_id', [ 'status' => 400 ] );

					$data = $this->get_user_progress( $user_id );
					if ( ! isset( $data[ $post_id ] ) ) {
						$data[ $post_id ] = [
							'post_id'         => $post_id,
							'pages'           => [],
							'last_page'       => 1,
							'total_pages'     => 1,
							'percent_overall' => 0,
							'status'          => 'reading',
							'updated_at'      => current_time( 'mysql', true ),
						];
					}

					$data[ $post_id ]['status']          = $locked ? 'locked_done' : 'reading';
					$data[ $post_id ]['percent_overall'] = $locked ? 100.0 : ( isset( $data[ $post_id ]['percent_overall'] ) ? $data[ $post_id ]['percent_overall'] : 0.0 );
					$data[ $post_id ]['updated_at']      = current_time( 'mysql', true );

					update_user_meta( $user_id, self::USERMETA_KEY, $data );

					return rest_ensure_response( $data[ $post_id ] );
				},
				'args'                => [
					'post_id' => [ 'required' => true ],
				],
			]
		);
	}

	/** ---------------- Helpers ---------------- */

	private function get_user_progress( $user_id ) {
		$data = get_user_meta( $user_id, self::USERMETA_KEY, true );
		if ( ! is_array( $data ) ) $data = [];
		$out = [];
		foreach ( $data as $pid => $record ) {
			$out[ (int) $pid ] = is_array( $record ) ? $record : [];
		}
		return $out;
	}

	private function compute_overall_percent( array $pages, $total ) {
		if ( $total <= 1 ) {
			$p = isset( $pages[1] ) ? (float) $pages[1] : 0.0;
			return max( 0.0, min( 100.0, $p ) );
		}
		$acc = 0.0;
		for ( $i = 1; $i <= $total; $i++ ) {
			$acc += ( isset( $pages[ $i ] ) ? max( 0.0, min( 100.0, (float) $pages[ $i ] ) ) : 0.0 ) / 100.0;
		}
		return max( 0.0, min( 100.0, ( $acc / $total ) * 100.0 ) );
	}
}

CZ_Continue_Reading::instance();

require_once CZCR_PLUGIN_PATH . 'inc/get-readings.php';
