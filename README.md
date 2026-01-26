# TimeKeeper

## Strava feed publishing (GitHub Pages)

This repo includes a GitHub Actions workflow that publishes a lightweight Strava JSON feed to `assets/strava.json`, which is rendered in the Workouts section of the app.

### Setup

1. Create a Strava API app and note the Client ID and Client Secret.
2. Generate a refresh token with the `activity:read_all` scope.
3. Add repository secrets in GitHub:
   - `STRAVA_CLIENT_ID`
   - `STRAVA_CLIENT_SECRET`

4. Store the refresh token in `_private/strava_token.json`. The workflow will update
   this file automatically if Strava rotates the refresh token.

The workflow fetches all available activities by paging through the Strava API.

Note: `_private/strava_token.json` contains a refresh token. Keep the repo private.

### Troubleshooting

If the workflow logs show `401 Unauthorized`, verify that the refresh token has `activity:read_all` scope and that the secrets match your Strava app credentials.
