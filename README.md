# TimeKeeper

## Strava feed publishing (GitHub Pages)

This repo includes a GitHub Actions workflow that publishes a lightweight Strava JSON feed to `assets/strava.json`, which is rendered in the Workouts section of the app.

### Setup

1. Create a Strava API app and note the Client ID and Client Secret.
2. Generate a refresh token with `read` and `activity:read_all` scopes.
3. Add repository secrets in GitHub:
   - `STRAVA_CLIENT_ID`
   - `STRAVA_CLIENT_SECRET`
   - `STRAVA_REFRESH_TOKEN`

Optional: set `STRAVA_PER_PAGE` to control how many activities to fetch (default: 20).

### Troubleshooting

If the workflow logs show `401 Unauthorized`, verify that the refresh token has `activity:read_all` scope and that the secrets match your Strava app credentials.
