#!/bin/sh
envsubst < /app/openapi.yaml > /app/openapi.yaml.tmp && mv /app/openapi.yaml.tmp /app/openapi.yaml
exec "$@"
