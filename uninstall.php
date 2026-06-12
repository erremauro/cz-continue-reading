<?php
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

global $wpdb;

$wpdb->delete( $wpdb->usermeta, [ 'meta_key' => '_czcr_progress_v1' ], [ '%s' ] );
