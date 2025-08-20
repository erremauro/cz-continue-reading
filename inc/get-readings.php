<?php

if ( ! function_exists( 'czcr_get_readings' ) ) {
	/**
	 * Get in-progress readings for a user (logged-in only).
	 *
	 * @param int|null $user_id Defaults to current user.
	 * @return array Array of records keyed by post_id.
	 */
	function czcr_get_readings( $user_id = null ) {
		$user_id = $user_id ? (int) $user_id : get_current_user_id();
		if ( $user_id <= 0 ) {
			// Guests: server cannot see localStorage; return empty.
			return [];
		}
		$data = get_user_meta( $user_id, CZ_Continue_Reading::USERMETA_KEY, true );
		if ( ! is_array( $data ) ) {
			$data = [];
		}

		$out = [];
		foreach ( $data as $pid => $rec ) {
			if ( ! is_array( $rec ) ) {
				continue;
			}
			$status  = isset( $rec['status'] ) ? $rec['status'] : 'reading';
			$overall = isset( $rec['percent_overall'] ) ? (float) $rec['percent_overall'] : 0.0;

			// Criteria: in lettura (0<%<100) e non bloccato/letto
			$include = ( 'locked_done' !== $status && $overall > 0 && $overall < 100 );

			/**
			 * Filter to customize inclusion logic.
			 * @param bool  $include Whether to include this record.
			 * @param array $rec     The record.
			 * @param int   $pid     Post ID.
			 */
			$include = apply_filters( 'czcr_include_in_readings', $include, $rec, (int) $pid );

			if ( $include ) {
				$out[ (int) $pid ] = $rec;
			}
		}

		/**
		 * Filter final readings array.
		 * @param array $out
		 * @param int   $user_id
		 */
		return apply_filters( 'czcr_get_readings', $out, $user_id );
	}
}

if ( ! function_exists( 'czcr_count_readings' ) ) {
	/**
	 * Count in-progress readings for a user.
	 *
	 * @param int|null $user_id
	 * @return int
	 */
	function czcr_count_readings( $user_id = null ) {
		return count( czcr_get_readings( $user_id ) );
	}
}

if ( ! function_exists( 'czcr_has_readings' ) ) {
	/**
	 * Quick boolean: does the user have any in-progress readings?
	 *
	 * @param int|null $user_id
	 * @return bool
	 */
	function czcr_has_readings( $user_id = null ) {
		$has = czcr_count_readings( $user_id ) > 0;

		/**
		 * Allow themes/plugins to override final boolean (e.g. consider guests).
		 * @param bool $has
		 * @param int|null $user_id
		 */
		return (bool) apply_filters( 'czcr_has_readings', $has, $user_id );
	}
}
