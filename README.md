# optimism-ts-services
[Optimism] Client-Side Services

## Message Passer

The Message Passer is used to confirm L2 to L1 messages on L1.
By default, it will send transactions to L1 when it detects that
it needs to. It can also be configured to write data to a Google
Sheet so that the transactions can be closely inspected.

To run in spreadsheet mode, the following environment variables
are used:

| Environment Variable | Description |
| -----------          | ----------- |
| `SPREADSHEET_MODE`   | Set this to anything to run in spreadsheet mode |
| `SHEET_ID`           | The ID of the Google Sheet, can be found in the URL |
| `CLIENT_EMAIL`       | A service account email address |
| `CLIENT_PRIVATE_KEY` | A service account RSA private key|

The key and service account can be managed at `console.developers.google.com`.
A Google Sheet must be created with the correct row headers and the `SHEET_ID`
can be pulled from the URL of the Google Sheet.
