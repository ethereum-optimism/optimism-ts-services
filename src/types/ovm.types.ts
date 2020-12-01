import { BigNumber } from 'ethers'
import { SecureTrie } from 'merkle-patricia-tree'

export interface StateRootBatchHeader {
  batchIndex: BigNumber
  batchRoot: string
  batchSize: BigNumber
  prevTotalElements: BigNumber
  extraData: string
}

export interface TransactionBatchHeader {
  batchIndex: BigNumber
  batchRoot: string
  batchSize: BigNumber
  prevTotalElements: BigNumber
  extraData: string
}

export interface SentMessage {
  target: string
  sender: string
  message: string
  messageNonce: number
  encodedMessage: string
  encodedMessageHash: string
  parentTransactionIndex: number
}

export interface StateRootProof {
  index: number
  siblings: string[]
}

export interface TransactionProof {
  index: number
  siblings: string[]
}

export interface SentMessageProof {
  stateRoot: string
  stateRootBatchHeader: StateRootBatchHeader
  stateRootProof: StateRootProof
  stateTrieWitness: string | Buffer
  storageTrieWitness: string | Buffer
}

export interface StateRootBatchProof {
  stateRoot: string
  stateRootBatchHeader: StateRootBatchHeader
  stateRootProof: StateRootProof
}

export interface TransactionBatchProof {
  transaction: string
  transactionBatchHeader: TransactionBatchHeader
  transactionProof: TransactionProof
}

export enum StateTransitionPhase {
  PRE_EXECUTION,
  POST_EXECUTION,
  COMPLETE,
}

export interface StateDiffProof {
  header: {
    number: number
    hash: string
    stateRoot: string
    timestamp: number
  }

  accounts: [
    {
      address: string
      accountProof: string[]
      balance: string
      codeHash: string
      nonce: string
      storageHash: string
      mutated: boolean
      storageProof: Array<{
        key: string
        value: string
        proof: string[]
        mutated: boolean
      }>
    }
  ]
}

export interface FraudProofData {
  proof: StateDiffProof
  stateTrie: SecureTrie
  storageTries: {
    [address: string]: SecureTrie
  }

  transaction: string
  transactionIndex: number
  transactionProof: TransactionBatchProof

  preStateRoot: string
  preStateRootIndex: number
  preStateRootProof: StateRootBatchProof

  postStateRoot: string
  postStateRootIndex: number
  postStateRootProof: StateRootBatchProof
}
