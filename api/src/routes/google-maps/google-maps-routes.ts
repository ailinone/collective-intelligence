// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Google Maps Integration Routes
 * Real implementation using Google Maps API
 * 
 * Features:
 * - Places search
 * - Geocoding / Reverse geocoding
 * - Directions
 * - Place details
 */

import type { FastifyInstance } from 'fastify';
import { logger } from '@/utils/logger';
import { authenticate as authenticateRequest } from '@/middleware/auth-middleware';
import { GoogleMapsService } from '@/services/google-maps-service';

const log = logger.child({ module: 'google-maps-routes' });

const googleMapsService = new GoogleMapsService();

export async function registerGoogleMapsRoutes(server: FastifyInstance): Promise<void> {
  // POST /v1/tools/google-maps/search
  server.post<{
    Body: {
      query: string;
      location?: { lat: number; lng: number };
      radius?: number;
      type?: string;
      language?: string;
    };
  }>('/v1/tools/google-maps/search', {
    schema: {
      tags: ['Tools', 'Google Maps'],
      summary: 'Search places',
      description: 'Searches for places (businesses, points of interest, landmarks) using the Google Maps Places API. Supports text queries with optional location bias, radius filtering, and place type filtering. Returns detailed place information including names, addresses, ratings, and place IDs for further operations.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query (place name, address, etc.)' },
          location: {
            type: 'object',
            properties: {
              lat: { type: 'number', description: 'Latitude for location bias' },
              lng: { type: 'number', description: 'Longitude for location bias' },
            },
            description: 'Location bias for search results',
          },
          radius: { type: 'number', minimum: 1, description: 'Search radius in meters' },
          type: { type: 'string', description: 'Place type filter (e.g., "restaurant", "hotel")' },
          language: { type: 'string', description: 'Language code for results (e.g., "en", "pt-BR")' },
        },
      },
      response: {
        200: {
          description: 'Places search completed successfully',
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  place_id: { type: 'string' },
                  name: { type: 'string' },
                  formatted_address: { type: 'string' },
                  geometry: {
                    type: 'object',
                    properties: {
                      location: {
                        type: 'object',
                        properties: {
                          lat: { type: 'number' },
                          lng: { type: 'number' },
                        },
                      },
                    },
                  },
                  rating: { type: 'number' },
                  types: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        400: {
          description: 'Bad request (invalid query)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        404: {
          description: 'Resource not found (e.g., location or place not found)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message indicating the requested resource was not found' },
                type: { type: 'string', description: 'Error type (e.g., "not_found_error")' },
                code: { type: 'string', description: 'Error code (e.g., "resource_not_found")' },
              },
            },
          },
        },
        503: {
          description: 'Service unavailable (Google Maps API not configured)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
      },
    },
    preHandler: authenticateRequest,
    handler: async (request, reply) => {
      try {
        if (!googleMapsService.isAvailable()) {
          return reply.code(503).send({
            error: {
              message: 'Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY environment variable.',
              type: 'service_unavailable',
            },
          });
        }

        const results = await googleMapsService.searchPlaces(request.body);
        return reply.send({ results });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error: errorMessage }, 'Search places failed');
        return reply.code(500).send({
          error: {
            message: errorMessage,
            type: 'google_maps_error',
          },
        });
      }
    },
  });

  // POST /v1/tools/google-maps/geocode
  server.post<{
    Body: {
      address: string;
      language?: string;
      region?: string;
    };
  }>('/v1/tools/google-maps/geocode', {
    schema: {
      tags: ['Tools', 'Google Maps'],
      summary: 'Geocode address',
      description: 'Converts a human-readable address or place name into geographic coordinates (latitude and longitude). Supports addresses in various formats and languages. Returns precise location data along with formatted addresses, location types, and place IDs. Essential for mapping applications and location-based services.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['address'],
        properties: {
          address: { type: 'string', description: 'Address to geocode' },
          language: { type: 'string', description: 'Language code for results' },
          region: { type: 'string', description: 'Region code for biasing results (e.g., "us", "br")' },
        },
      },
      response: {
        200: {
          description: 'Geocoding completed successfully',
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  formatted_address: { type: 'string' },
                  geometry: {
                    type: 'object',
                    properties: {
                      location: {
                        type: 'object',
                        properties: {
                          lat: { type: 'number' },
                          lng: { type: 'number' },
                        },
                      },
                    },
                  },
                  place_id: { type: 'string' },
                  types: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        400: {
          description: 'Bad request (invalid address)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
        503: {
          description: 'Service unavailable (Google Maps API not configured)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
      },
    },
    preHandler: authenticateRequest,
    handler: async (request, reply) => {
      try {
        if (!googleMapsService.isAvailable()) {
          return reply.code(503).send({
            error: {
              message: 'Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY environment variable.',
              type: 'service_unavailable',
            },
          });
        }

        const results = await googleMapsService.geocode(request.body);
        return reply.send({ results });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error: errorMessage }, 'Geocode failed');
        return reply.code(500).send({
          error: {
            message: errorMessage,
            type: 'google_maps_error',
          },
        });
      }
    },
  });

  // POST /v1/tools/google-maps/reverse-geocode
  server.post<{
    Body: {
      lat: number;
      lng: number;
      language?: string;
    };
  }>('/v1/tools/google-maps/reverse-geocode', {
    schema: {
      tags: ['Tools', 'Google Maps'],
      summary: 'Reverse geocode coordinates',
      description: 'Converts geographic coordinates (latitude and longitude) into human-readable addresses and location information. Returns formatted addresses, location components, place IDs, and administrative boundaries. Useful for displaying user-friendly location information from GPS coordinates or map clicks.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['lat', 'lng'],
        properties: {
          lat: { type: 'number', minimum: -90, maximum: 90, description: 'Latitude (-90 to 90)' },
          lng: { type: 'number', minimum: -180, maximum: 180, description: 'Longitude (-180 to 180)' },
          language: { type: 'string', description: 'Language code for results' },
        },
      },
      response: {
        200: {
          description: 'Reverse geocoding completed successfully',
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  formatted_address: { type: 'string' },
                  place_id: { type: 'string' },
                  types: { type: 'array', items: { type: 'string' } },
                  geometry: {
                    type: 'object',
                    properties: {
                      location: {
                        type: 'object',
                        properties: {
                          lat: { type: 'number' },
                          lng: { type: 'number' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        400: {
          description: 'Bad request (invalid coordinates)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
        503: {
          description: 'Service unavailable (Google Maps API not configured)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
      },
    },
    preHandler: authenticateRequest,
    handler: async (request, reply) => {
      try {
        if (!googleMapsService.isAvailable()) {
          return reply.code(503).send({
            error: {
              message: 'Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY environment variable.',
              type: 'service_unavailable',
            },
          });
        }

        const results = await googleMapsService.reverseGeocode(request.body);
        return reply.send({ results });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error: errorMessage }, 'Reverse geocode failed');
        return reply.code(500).send({
          error: {
            message: errorMessage,
            type: 'google_maps_error',
          },
        });
      }
    },
  });

  // POST /v1/tools/google-maps/directions
  server.post<{
    Body: {
      origin: string | { lat: number; lng: number };
      destination: string | { lat: number; lng: number };
      mode?: 'driving' | 'walking' | 'bicycling' | 'transit';
      language?: string;
      alternatives?: boolean;
      avoid?: ('tolls' | 'highways' | 'ferries' | 'indoor')[];
    };
  }>('/v1/tools/google-maps/directions', {
    schema: {
      tags: ['Tools', 'Google Maps'],
      summary: 'Get directions',
      description: 'Retrieves detailed turn-by-turn directions between two locations using the Google Maps Directions API. Supports multiple travel modes (driving, walking, bicycling, transit), route optimization, waypoints, and alternative routes. Returns step-by-step directions, distances, durations, and route geometry for mapping applications.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['origin', 'destination'],
        properties: {
          origin: {
            oneOf: [
              { type: 'string', description: 'Address string (e.g., "1600 Amphitheatre Parkway, Mountain View, CA")' },
              {
                type: 'object',
                description: 'Coordinate object with latitude and longitude',
                properties: {
                  lat: { type: 'number', description: 'Latitude coordinate (-90 to 90)' },
                  lng: { type: 'number', description: 'Longitude coordinate (-180 to 180)' },
                },
              },
            ],
          },
          destination: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  lat: { type: 'number' },
                  lng: { type: 'number' },
                },
              },
            ],
          },
          mode: { 
            type: 'string', 
            enum: ['driving', 'walking', 'bicycling', 'transit'],
            description: 'Travel mode: driving (default), walking, bicycling, or transit (public transport)',
          },
          language: { 
            type: 'string',
            description: 'Language code for route instructions (e.g., "en", "pt-BR"). Default: "en"',
          },
          alternatives: { 
            type: 'boolean',
            description: 'Whether to return alternative routes (if available). Default: false',
          },
          avoid: {
            type: 'array',
            items: { type: 'string', enum: ['tolls', 'highways', 'ferries', 'indoor'] },
            description: 'Routes to avoid',
          },
        },
      },
      response: {
        200: {
          description: 'Directions retrieved successfully',
          type: 'object',
          properties: {
            routes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  summary: { type: 'string' },
                  legs: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        distance: { type: 'object', properties: { value: { type: 'number' }, text: { type: 'string' } } },
                        duration: { type: 'object', properties: { value: { type: 'number' }, text: { type: 'string' } } },
                        start_address: { type: 'string' },
                        end_address: { type: 'string' },
                        steps: { type: 'array' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        400: {
          description: 'Bad request (invalid origin or destination)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
        503: {
          description: 'Service unavailable (Google Maps API not configured)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
      },
    },
    preHandler: authenticateRequest,
    handler: async (request, reply) => {
      try {
        if (!googleMapsService.isAvailable()) {
          return reply.code(503).send({
            error: {
              message: 'Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY environment variable.',
              type: 'service_unavailable',
            },
          });
        }

        const result = await googleMapsService.getDirections(request.body);
        return reply.send(result);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error: errorMessage }, 'Get directions failed');
        return reply.code(500).send({
          error: {
            message: errorMessage,
            type: 'google_maps_error',
          },
        });
      }
    },
  });

  // POST /v1/tools/google-maps/place-details
  server.post<{
    Body: {
      place_id: string;
      fields?: string[];
      language?: string;
    };
  }>('/v1/tools/google-maps/place-details', {
    schema: {
      tags: ['Tools', 'Google Maps'],
      summary: 'Get place details',
      description: 'Retrieves comprehensive information about a specific place using its place ID. Returns detailed data including address, phone number, website, opening hours, ratings, reviews, photos, and amenities. Supports field filtering to request only needed information, optimizing response size and API costs. Essential for building detailed place profile pages.',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: ['place_id'],
        properties: {
          place_id: { type: 'string', description: 'Google Places place_id' },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Fields to return (e.g., ["name", "rating", "formatted_address"])',
          },
          language: { type: 'string', description: 'Language code for results' },
        },
      },
      response: {
        200: {
          description: 'Place details retrieved successfully',
          type: 'object',
          properties: {
            result: {
              type: 'object',
              properties: {
                place_id: { type: 'string' },
                name: { type: 'string' },
                formatted_address: { type: 'string' },
                formatted_phone_number: { type: 'string' },
                rating: { type: 'number' },
                geometry: {
                  type: 'object',
                  properties: {
                    location: {
                      type: 'object',
                      properties: {
                        lat: { type: 'number' },
                        lng: { type: 'number' },
                      },
                    },
                  },
                },
                opening_hours: { type: 'object' },
                photos: { type: 'array' },
              },
            },
          },
        },
        400: {
          description: 'Bad request (invalid place_id)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
        503: {
          description: 'Service unavailable (Google Maps API not configured)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                type: { type: 'string' },
                code: { type: 'string' },
              },
            },
          },
        },
      },
    },
    preHandler: authenticateRequest,
    handler: async (request, reply) => {
      try {
        if (!googleMapsService.isAvailable()) {
          return reply.code(503).send({
            error: {
              message: 'Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY environment variable.',
              type: 'service_unavailable',
            },
          });
        }

        const result = await googleMapsService.getPlaceDetails(request.body);
        return reply.send({ result });
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        log.error({ error: errorMessage }, 'Get place details failed');
        return reply.code(500).send({
          error: {
            message: errorMessage,
            type: 'google_maps_error',
          },
        });
      }
    },
  });

  // Legacy endpoint for compatibility
  server.post('/v1/tools/google-maps', {
    schema: {
      tags: ['Tools', 'Google Maps'],
      summary: 'Google Maps integration (legacy)',
      description: 'Legacy endpoint. Use specific endpoints: /search, /geocode, /directions, /place-details',
      security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
      body: {
        type: 'object',
        required: [],
        properties: {
          operation: {
            type: 'string',
            description: 'Legacy operation type. This endpoint is deprecated - use specific endpoints instead.',
          },
        },
      },
      response: {
        200: {
          description: 'Google Maps service status',
          type: 'object',
          properties: {
            message: { type: 'string', description: 'Status message indicating the service availability' },
            available: { type: 'boolean', description: 'Whether Google Maps API is configured and available' },
          },
        },
        400: {
          description: 'Bad request (invalid parameters)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the validation failure' },
                type: { type: 'string', description: 'Error type (e.g., "invalid_request_error")' },
                code: { type: 'string', description: 'Error code (e.g., "invalid_parameter")' },
              },
            },
          },
        },
        401: {
          description: 'Unauthorized (invalid or missing authentication token)',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message' },
                type: { type: 'string', description: 'Error type (e.g., "authentication_error")' },
                code: { type: 'string', description: 'Error code (e.g., "unauthorized")' },
              },
            },
          },
        },
        500: {
          description: 'Internal server error',
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string', description: 'Error message describing the server error' },
                type: { type: 'string', description: 'Error type (e.g., "server_error")' },
                code: { type: 'string', description: 'Error code (e.g., "internal_error")' },
              },
            },
          },
        },
      },
    },
    preHandler: authenticateRequest,
    handler: async (_request, reply) => {
      return reply.send({
        message: 'Google Maps integration is available. Use specific endpoints: /v1/tools/google-maps/search, /geocode, /reverse-geocode, /directions, /place-details',
        available: googleMapsService.isAvailable(),
      });
    },
  });

  log.info('Google Maps routes registered successfully');
}

