import { Wallet } from 'ethers'
import { JsonRpcProvider } from '@ethersproject/providers'
import { MessageRelayerService } from '../services/message-relayer.service'
import SpreadSheet from '../utils/spreadsheet'
import { config } from 'dotenv'
config()

const env = process.env
const L2_NODE_WEB3_URL = env.L2_NODE_WEB3_URL
const L1_NODE_WEB3_URL = env.L1_NODE_WEB3_URL
const ADDRESS_MANAGER_ADDRESS = env.ADDRESS_MANAGER_ADDRESS
const L1_WALLET_KEY = env.L1_WALLET_KEY
const RELAY_GAS_LIMIT = env.RELAY_GAS_LIMIT || '4000000'
const POLLING_INTERVAL = env.POLLING_INTERVAL || '5000'
const L2_BLOCK_OFFSET = env.L2_BLOCK_OFFSET || '1'
const L1_START_OFFSET = env.L1_BLOCK_OFFSET || '1'
const FROM_L2_TRANSACTION_INDEX = env.FROM_L2_TRANSACTION_INDEX || '0'

// Spreadsheet configuration
const SPREADSHEET_MODE = env.SPREADSHEET_MODE || ''
const SHEET_ID = env.SHEET_ID || ''
const CLIENT_EMAIL = env.CLIENT_EMAIL || ''
const CLIENT_PRIVATE_KEY = env.CLIENT_PRIVATE_KEY || ''

const main = async () => {
  if (!ADDRESS_MANAGER_ADDRESS) {
    throw new Error('Must pass ADDRESS_MANAGER_ADDRESS')
  }
  if (!L1_NODE_WEB3_URL) {
    throw new Error('Must pass L1_NODE_WEB3_URL')
  }
  if (!L2_NODE_WEB3_URL) {
    throw new Error('Must pass L2_NODE_WEB3_URL')
  }
  if (!L1_WALLET_KEY) {
    throw new Error('Must pass L1_WALLET_KEY')
  }

  const l2Provider = new JsonRpcProvider(L2_NODE_WEB3_URL)
  const l1Provider = new JsonRpcProvider(L1_NODE_WEB3_URL)

  const wallet = new Wallet(L1_WALLET_KEY, l1Provider)

  let spreadsheet = null
  if (SPREADSHEET_MODE) {
    if (!SHEET_ID) {
      throw new Error('Must pass SHEET_ID')
    }
    if (!CLIENT_EMAIL) {
      throw new Error('Must pass CLIENT_EMAIL')
    }
    if (!CLIENT_PRIVATE_KEY) {
      throw new Error('Must pass CLIENT_PRIVATE_KEY')
    }
    const privateKey = CLIENT_PRIVATE_KEY.replace(/\\n/g, '\n')
    spreadsheet = new SpreadSheet(SHEET_ID)
    await spreadsheet.init(CLIENT_EMAIL, privateKey)
  }

  const service = new MessageRelayerService({
    l1RpcProvider: l1Provider,
    l2RpcProvider: l2Provider,
    addressManagerAddress: ADDRESS_MANAGER_ADDRESS,
    l1Wallet: wallet,
    relayGasLimit: parseInt(RELAY_GAS_LIMIT, 10),
    fromL2TransactionIndex: parseInt(FROM_L2_TRANSACTION_INDEX, 10),
    pollingInterval: parseInt(POLLING_INTERVAL, 10),
    l2BlockOffset: parseInt(L2_BLOCK_OFFSET, 10),
    l1StartOffset: parseInt(L1_START_OFFSET, 10),
    spreadsheetMode: !!SPREADSHEET_MODE,
    spreadsheet,
  })

  await service.start()
}
export default main

