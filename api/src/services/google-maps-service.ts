// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Google Maps Service
 * Real implementation using Google Maps API
 * 
 * Features:
 * - Places search (find places by name/type)
 * - Geocoding (address to coordinates)
 * - Reverse geocoding (coordinates to address)
 * - Directions (routes between locations)
 * - Distance calculation
 * - Place details
 */

import { logger } from '@/utils/logger';
import { config } from '@/config';

const log = logger.child({ service: 'google-maps' });

// Every fetch below hits the external Google Maps API with NO deadline of its
// own — a hung upstream held the request open indefinitely (this service was
// the only external-call site in the codebase without a timeout). 8s bounds
// the worst case well above Google's normal p99 while still failing fast.
const GOOGLE_MAPS_TIMEOUT_MS = Number(process.env.GOOGLE_MAPS_TIMEOUT_MS) || 8000;

export interface GoogleMapsPlaceSearchRequest {
  query: string;
  location?: {
    lat: number;
    lng: number;
  };
  radius?: number; // in meters
  type?: string; // place type (restaurant, hospital, etc.)
  language?: string;
}

export interface GoogleMapsPlaceSearchResult {
  place_id: string;
  name: string;
  formatted_address: string;
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
  };
  types: string[];
  rating?: number;
  user_ratings_total?: number;
}

export interface GoogleMapsGeocodeRequest {
  address: string;
  language?: string;
  region?: string;
}

export interface GoogleMapsGeocodeResult {
  place_id: string;
  formatted_address: string;
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
    location_type: string;
  };
  types: string[];
}

export interface GoogleMapsReverseGeocodeRequest {
  lat: number;
  lng: number;
  language?: string;
}

export interface GoogleMapsDirectionsRequest {
  origin: string | { lat: number; lng: number };
  destination: string | { lat: number; lng: number };
  mode?: 'driving' | 'walking' | 'bicycling' | 'transit';
  language?: string;
  alternatives?: boolean;
  avoid?: ('tolls' | 'highways' | 'ferries' | 'indoor')[];
}

export interface GoogleMapsDirectionsResult {
  routes: Array<{
    summary: string;
    legs: Array<{
      distance: {
        text: string;
        value: number; // in meters
      };
      duration: {
        text: string;
        value: number; // in seconds
      };
      start_address: string;
      end_address: string;
      start_location: {
        lat: number;
        lng: number;
      };
      end_location: {
        lat: number;
        lng: number;
      };
      steps: Array<{
        html_instructions: string;
        distance: {
          text: string;
          value: number;
        };
        duration: {
          text: string;
          value: number;
        };
        start_location: {
          lat: number;
          lng: number;
        };
        end_location: {
          lat: number;
          lng: number;
        };
      }>;
    }>;
    overview_polyline: {
      points: string;
    };
  }>;
}

export interface GoogleMapsPlaceDetailsRequest {
  place_id: string;
  fields?: string[];
  language?: string;
}

export interface GoogleMapsPlaceDetailsResult {
  place_id: string;
  name: string;
  formatted_address: string;
  formatted_phone_number?: string;
  international_phone_number?: string;
  website?: string;
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
    viewport: {
      northeast: {
        lat: number;
        lng: number;
      };
      southwest: {
        lat: number;
        lng: number;
      };
    };
  };
  types: string[];
  rating?: number;
  user_ratings_total?: number;
  opening_hours?: {
    open_now: boolean;
    weekday_text: string[];
  };
  photos?: Array<{
    photo_reference: string;
    height: number;
    width: number;
  }>;
}

export class GoogleMapsService {
  private apiKey: string | null;
  private baseUrl = 'https://maps.googleapis.com/maps/api';

  constructor() {
    // Try to get Google Maps API key from config or environment
    const providers = config.providers || [];
    const googleProvider = Array.isArray(providers) 
      ? providers.find((p) => p.name === 'google')
      : null;
    const googleApiKey = googleProvider && 'apiKey' in googleProvider ? googleProvider.apiKey : null;
    this.apiKey = googleApiKey || process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || null;
    
    if (!this.apiKey) {
      log.warn('Google Maps API key not configured. Google Maps functionality will be unavailable.');
    }
  }

  /**
   * Check if service is available
   */
  isAvailable(): boolean {
    return this.apiKey !== null;
  }

  /**
   * Search for places
   */
  async searchPlaces(request: GoogleMapsPlaceSearchRequest): Promise<GoogleMapsPlaceSearchResult[]> {
    if (!this.apiKey) {
      throw new Error('Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY environment variable.');
    }

    const params = new URLSearchParams({
      key: this.apiKey,
      query: request.query,
    });

    if (request.location) {
      params.append('location', `${request.location.lat},${request.location.lng}`);
    }

    if (request.radius) {
      params.append('radius', request.radius.toString());
    }

    if (request.type) {
      params.append('type', request.type);
    }

    if (request.language) {
      params.append('language', request.language);
    }

    try {
      const url = `${this.baseUrl}/place/textsearch/json?${params.toString()}`;
      log.debug({ url: url.replace(this.apiKey, '***') }, 'Searching places');

      const response = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_MAPS_TIMEOUT_MS) });
      const data = await response.json() as {
        status: string;
        results: Array<{
          place_id: string;
          name: string;
          formatted_address: string;
          geometry: {
            location: {
              lat: number;
              lng: number;
            };
          };
          types: string[];
          rating?: number;
          user_ratings_total?: number;
        }>;
        error_message?: string;
      };

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        throw new Error(`Google Maps API error: ${data.status}${data.error_message ? ` - ${data.error_message}` : ''}`);
      }

      return data.results || [];
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ error: errorMessage, query: request.query }, 'Failed to search places');
      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }

  /**
   * Geocode an address to coordinates
   */
  async geocode(request: GoogleMapsGeocodeRequest): Promise<GoogleMapsGeocodeResult[]> {
    if (!this.apiKey) {
      throw new Error('Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY environment variable.');
    }

    const params = new URLSearchParams({
      key: this.apiKey,
      address: request.address,
    });

    if (request.language) {
      params.append('language', request.language);
    }

    if (request.region) {
      params.append('region', request.region);
    }

    try {
      const url = `${this.baseUrl}/geocode/json?${params.toString()}`;
      log.debug({ url: url.replace(this.apiKey, '***') }, 'Geocoding address');

      const response = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_MAPS_TIMEOUT_MS) });
      const data = await response.json() as {
        status: string;
        results: Array<{
          place_id: string;
          formatted_address: string;
          geometry: {
            location: {
              lat: number;
              lng: number;
            };
            location_type: string;
          };
          types: string[];
        }>;
        error_message?: string;
      };

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        throw new Error(`Google Maps API error: ${data.status}${data.error_message ? ` - ${data.error_message}` : ''}`);
      }

      return data.results || [];
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ error: errorMessage, address: request.address }, 'Failed to geocode address');
      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }

  /**
   * Reverse geocode coordinates to address
   */
  async reverseGeocode(request: GoogleMapsReverseGeocodeRequest): Promise<GoogleMapsGeocodeResult[]> {
    if (!this.apiKey) {
      throw new Error('Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY environment variable.');
    }

    const params = new URLSearchParams({
      key: this.apiKey,
      latlng: `${request.lat},${request.lng}`,
    });

    if (request.language) {
      params.append('language', request.language);
    }

    try {
      const url = `${this.baseUrl}/geocode/json?${params.toString()}`;
      log.debug({ url: url.replace(this.apiKey, '***') }, 'Reverse geocoding coordinates');

      const response = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_MAPS_TIMEOUT_MS) });
      const data = await response.json() as {
        status: string;
        results: Array<{
          place_id: string;
          formatted_address: string;
          geometry: {
            location: {
              lat: number;
              lng: number;
            };
            location_type: string;
          };
          types: string[];
        }>;
        error_message?: string;
      };

      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        throw new Error(`Google Maps API error: ${data.status}${data.error_message ? ` - ${data.error_message}` : ''}`);
      }

      return data.results || [];
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ error: errorMessage, lat: request.lat, lng: request.lng }, 'Failed to reverse geocode coordinates');
      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }

  /**
   * Get directions between two points
   */
  async getDirections(request: GoogleMapsDirectionsRequest): Promise<GoogleMapsDirectionsResult> {
    if (!this.apiKey) {
      throw new Error('Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY environment variable.');
    }

    const params = new URLSearchParams({
      key: this.apiKey,
      origin: typeof request.origin === 'string' ? request.origin : `${request.origin.lat},${request.origin.lng}`,
      destination: typeof request.destination === 'string' ? request.destination : `${request.destination.lat},${request.destination.lng}`,
    });

    if (request.mode) {
      params.append('mode', request.mode);
    }

    if (request.language) {
      params.append('language', request.language);
    }

    if (request.alternatives) {
      params.append('alternatives', 'true');
    }

    if (request.avoid && request.avoid.length > 0) {
      params.append('avoid', request.avoid.join('|'));
    }

    try {
      const url = `${this.baseUrl}/directions/json?${params.toString()}`;
      log.debug({ url: url.replace(this.apiKey, '***') }, 'Getting directions');

      const response = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_MAPS_TIMEOUT_MS) });
      const data = await response.json() as {
        status: string;
        routes: Array<{
          summary: string;
          legs: Array<{
            distance: {
              text: string;
              value: number;
            };
            duration: {
              text: string;
              value: number;
            };
            start_address: string;
            end_address: string;
            start_location: {
              lat: number;
              lng: number;
            };
            end_location: {
              lat: number;
              lng: number;
            };
            steps: Array<{
              html_instructions: string;
              distance: {
                text: string;
                value: number;
              };
              duration: {
                text: string;
                value: number;
              };
              start_location: {
                lat: number;
                lng: number;
              };
              end_location: {
                lat: number;
                lng: number;
              };
            }>;
          }>;
          overview_polyline: {
            points: string;
          };
        }>;
        error_message?: string;
      };

      if (data.status !== 'OK') {
        throw new Error(`Google Maps API error: ${data.status}${data.error_message ? ` - ${data.error_message}` : ''}`);
      }

      return {
        routes: data.routes || [],
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ error: errorMessage }, 'Failed to get directions');
      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }

  /**
   * Get place details
   */
  async getPlaceDetails(request: GoogleMapsPlaceDetailsRequest): Promise<GoogleMapsPlaceDetailsResult> {
    if (!this.apiKey) {
      throw new Error('Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY environment variable.');
    }

    const params = new URLSearchParams({
      key: this.apiKey,
      place_id: request.place_id,
    });

    if (request.fields && request.fields.length > 0) {
      params.append('fields', request.fields.join(','));
    }

    if (request.language) {
      params.append('language', request.language);
    }

    try {
      const url = `${this.baseUrl}/place/details/json?${params.toString()}`;
      log.debug({ url: url.replace(this.apiKey, '***') }, 'Getting place details');

      const response = await fetch(url, { signal: AbortSignal.timeout(GOOGLE_MAPS_TIMEOUT_MS) });
      const data = await response.json() as {
        status: string;
        result: {
          place_id: string;
          name: string;
          formatted_address: string;
          formatted_phone_number?: string;
          international_phone_number?: string;
          website?: string;
          geometry: {
            location: {
              lat: number;
              lng: number;
            };
            viewport: {
              northeast: {
                lat: number;
                lng: number;
              };
              southwest: {
                lat: number;
                lng: number;
              };
            };
          };
          types: string[];
          rating?: number;
          user_ratings_total?: number;
          opening_hours?: {
            open_now: boolean;
            weekday_text: string[];
          };
          photos?: Array<{
            photo_reference: string;
            height: number;
            width: number;
          }>;
        };
        error_message?: string;
      };

      if (data.status !== 'OK') {
        throw new Error(`Google Maps API error: ${data.status}${data.error_message ? ` - ${data.error_message}` : ''}`);
      }

      return data.result;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log.error({ error: errorMessage, place_id: request.place_id }, 'Failed to get place details');
      throw error instanceof Error ? error : new Error(errorMessage);
    }
  }
}

