# optimism-ts-services
[Optimism] Client-Side Services

## Fraud Prover

| Environment Variable        | Required? | Default Value         | Description            |
| -----------                 | --------- | -------------         | -----------           |
| `L1_WALLET_KEY`             | Yes       | N/A                   | Private key for an account on Layer 1 (Ethereum) to be used to submit fraud proof transactions. |
| `L2_NODE_WEB3_URL`          | No        | http://localhost:9545 | HTTP endpoint for a Layer 2 (Optimism) Verifier node.  |
| `L1_NODE_WEB3_URL`          | No        | http://localhost:8545 | HTTP endpoint for a Layer 1 (Ethereum) node.      |
| `RELAY_GAS_LIMIT`           | No        | 9,000,000             | Maximum amount of gas to provide to fraud proof transactions (except for the "transaction execution" step). |
| `RUN_GAS_LIMIT`             | No        | 9,000,000             | Maximum amount of gas to provide to the "transaction execution" step. |
| `POLLING_INTERVAL`          | No        | 5,000                 | Time (in milliseconds) to wait while polling for new transactions. |
| `L2_BLOCK_OFFSET`           | No        | 1                     | Offset between the `CanonicalTransactionChain` contract on Layer 1 and the blocks on Layer 2. Currently defaults to 1, but will likely be removed as soon as possible. |
| `L1_BLOCK_FINALITY`         | No        | 0                     | Number of Layer 1 blocks to wait before considering a given event. |
| `L1_BLOCK_OFFSET`           | No        | 0                     | Layer 1 block number to start scanning for transactions from. |
| `FROM_L2_TRANSACTION_INDEX` | No        | 0                     | Layer 2 block number to start scanning for transactions from. |

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
