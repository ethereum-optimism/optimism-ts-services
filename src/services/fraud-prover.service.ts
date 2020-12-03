/* Imports: External */
import { Contract, Signer, BigNumber, ethers } from 'ethers'
import { JsonRpcProvider } from '@ethersproject/providers'
import { SecureTrie, BaseTrie } from 'merkle-patricia-tree'
import * as rlp from 'rlp'

/* Imports: Internal */
import { BaseService } from './base.service'
import { StateDiffProof, StateTransitionPhase, FraudProofData, SequencerTransaction } from '../types'
import {
  sleep,
  ZERO_ADDRESS,
  loadContract,
  loadContractFromManager,
  loadProxyFromManager,
  L1ProviderWrapper,
  L2ProviderWrapper,
  toHexString,
  fromHexString,
  encodeAccountState,
  decodeAccountState,
} from '../utils'

interface FraudProverOptions {
  l1RpcProvider: JsonRpcProvider
  l2RpcProvider: JsonRpcProvider
  addressManagerAddress: string
  l1Wallet: Signer
  deployGasLimit: number
  pollingInterval: number
  fromL2TransactionIndex: number
  l2BlockOffset: number
}

export const updateAndProve = async (
  trie: BaseTrie,
  key: Buffer,
  value: Buffer
): Promise<string> => {
  const proof = await BaseTrie.createProof(trie, key)
  const encodedProof = toHexString(rlp.encode(proof))
  await trie.put(key, value)
  return encodedProof
}

export class FraudProverService extends BaseService<FraudProverOptions> {
  protected name = 'Fraud Prover'
  protected defaultOptions = {
    pollingInterval: 5000,
    deployGasLimit: 4_000_000,
    fromL2TransactionIndex: 0,
    l2BlockOffset: 1,
  }

  private state: {
    nextUnverifiedStateRoot: number
    l1Provider: L1ProviderWrapper
    l2Provider: L2ProviderWrapper
    Lib_AddressManager: Contract
    OVM_StateCommitmentChain: Contract
    OVM_CanonicalTransactionChain: Contract
    OVM_FraudVerifier: Contract
  }

  protected async _init(): Promise<void> {
    // Need to improve this, sorry.
    this.state = {} as any

    this.state.Lib_AddressManager = loadContract(
      'Lib_AddressManager',
      this.options.addressManagerAddress,
      this.options.l1RpcProvider
    )

    this.logger.info('Connecting to OVM_StateCommitmentChain...')
    this.state.OVM_StateCommitmentChain = await loadContractFromManager(
      'OVM_StateCommitmentChain',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_StateCommitmentChain at address: ${this.state.OVM_StateCommitmentChain.address}`
    )

    this.logger.info('Connecting to OVM_CanonicalTransactionChain...')
    this.state.OVM_CanonicalTransactionChain = await loadContractFromManager(
      'OVM_CanonicalTransactionChain',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_CanonicalTransactionChain at address: ${this.state.OVM_CanonicalTransactionChain.address}`
    )

    this.logger.info('Connecting to OVM_FraudVerifier...')
    this.state.OVM_FraudVerifier = await loadContractFromManager(
      'OVM_FraudVerifier',
      this.state.Lib_AddressManager,
      this.options.l1RpcProvider
    )
    this.logger.info(
      `Connected to OVM_FraudVerifier at address: ${this.state.OVM_FraudVerifier.address}`
    )

    this.logger.success('Connected to all contracts.')

    this.state.l1Provider = new L1ProviderWrapper(
      this.options.l1RpcProvider,
      this.state.OVM_StateCommitmentChain,
      this.state.OVM_CanonicalTransactionChain
    )
    this.state.l2Provider = new L2ProviderWrapper(this.options.l2RpcProvider)

    this.state.nextUnverifiedStateRoot = this.options.fromL2TransactionIndex || 0
  }

  protected async _start(): Promise<void> {
    while (this.running) {
      await sleep(this.options.pollingInterval)

      try {
        this.logger.info(`Retrieving batch header for state root index: ${this.state.nextUnverifiedStateRoot}`)
        let nextStateBatchHeader = await this.state.l1Provider.getStateRootBatchHeader(
          this.state.nextUnverifiedStateRoot
        )

        if (nextStateBatchHeader === undefined) {
          this.logger.info(`Didn't find a batch header for the given index. Trying again in ${Math.floor(this.options.pollingInterval / 1000)} seconds...`)
          continue
        }

        let transactionIndex: number = undefined
        let nextBatchStateRoots: string[] = []
        while (nextStateBatchHeader !== undefined && transactionIndex === undefined) {
          nextBatchStateRoots = await this.state.l1Provider.getBatchStateRoots(
            this.state.nextUnverifiedStateRoot
          )

          this.logger.info(`Checking for any mismatched state roots...`)
          for (let i = 0; i < nextStateBatchHeader.batchSize.toNumber(); i++) {
            const l1StateRoot = nextBatchStateRoots[i]
            const l1StateRootIndex = this.state.nextUnverifiedStateRoot + i

            this.logger.info(`Checking state root for mismatch: ${l1StateRootIndex}`)
            const l2StateRoot = await this.state.l2Provider.getStateRoot(
              l1StateRootIndex + this.options.l2BlockOffset
            )

            if (l1StateRoot !== l2StateRoot) {
              transactionIndex = l1StateRootIndex
              this.logger.interesting(`Found a mismatched state root at index ${transactionIndex}!`)
              this.logger.interesting(`State root published to Layer 1 was: ${l1StateRoot}`)
              this.logger.interesting(`State root published to Layer 2 was: ${l2StateRoot}`)
              this.logger.interesting(`Starting the fraud proof process...`)
              break
            } else {
              this.logger.info(`No state root mismatch, checking the next root.`)
            }
          }

          if (transactionIndex === undefined) {
            this.state.nextUnverifiedStateRoot += nextStateBatchHeader.batchSize.toNumber()
          } else {
            break
          }

          this.logger.info(`Moving on to the next batch, starting with state root index: ${this.state.nextUnverifiedStateRoot}`)
          nextStateBatchHeader = await this.state.l1Provider.getStateRootBatchHeader(
            this.state.nextUnverifiedStateRoot
          )
        }

        if (transactionIndex === undefined) {
          this.logger.info(`Didn't find any mismatched state roots. Trying again in ${Math.floor(this.options.pollingInterval / 1000)} seconds...`)
          continue
        }

        this.logger.info(`Retrieving all relevant proof data for transaction at index: ${transactionIndex}`)
        const proof = await this._getTxFraudProofData(transactionIndex)

        this.logger.info(`Checking for an existing state transitioner...`)
        let stateTransitionerAddress = await this._getStateTransitioner(
          nextBatchStateRoots[transactionIndex - nextStateBatchHeader.prevTotalElements.toNumber()],
          proof.transactionProof.transaction
        )

        // 3. If not, start the fraud proof process.
        if (stateTransitionerAddress === ZERO_ADDRESS) {
          this.logger.info(`Transaction does not have an existing state transitioner, initializing...`)
          await this._initializeFraudVerification(proof)

          this.logger.info(`Retrieving the new state transitione address...`)
          stateTransitionerAddress = await this._getStateTransitioner(
            nextBatchStateRoots[transactionIndex - nextStateBatchHeader.prevTotalElements.toNumber()],
            proof.transactionProof.transaction
          )
          this.logger.info(`State transitioner is at address: ${stateTransitionerAddress}`)
        }

        const OVM_StateTransitioner = loadContract(
          'OVM_StateTransitioner',
          stateTransitionerAddress,
          this.options.l1RpcProvider
        )

        this.logger.info(`Loading the corresponding state manager...`)
        const stateManagerAddress = await OVM_StateTransitioner.ovmStateManager()
        const OVM_StateManager = loadContract(
          'OVM_StateManager',
          stateManagerAddress,
          this.options.l1RpcProvider
        )
        this.logger.info(`State manager is at address: ${stateManagerAddress}`)

        if (
          (await OVM_StateTransitioner.phase()) ===
          StateTransitionPhase.PRE_EXECUTION
        ) {
          this.logger.info(`Proof is currently in the PRE_EXECUTION phase.`)
  
          for (const account of proof.proof.accounts) {
            this.logger.info(`Checking if we've already proven account: ${account.address}`)
            const existingAccount = await OVM_StateManager.getAccount(account.address)

            if (existingAccount.codeHash === account.codeHash) {
              this.logger.info(`Account has already been proven, skipping: ${account.address}`)
            } else {
              this.logger.interesting(`Account has not been proven. Grabbing code to deploy a copy...`)
              const code = await this.options.l2RpcProvider.getCode(
                account.address
              )
  
              this.logger.info(`Deploying a copy of the code of the account...`)
              const ethContractAddress = await this._deployContractCode(code)
  
              this.logger.info(`Attempting to prove the state of the account...`)
              await OVM_StateTransitioner.connect(this.options.l1Wallet).proveContractState(
                account.address,
                ethContractAddress,
                {
                  nonce: account.nonce,
                  balance: account.balance,
                  storageRoot: account.storageHash,
                  codeHash: account.codeHash,
                },
                rlp.encode(account.accountProof)
              )
  
              this.logger.success(`Finished proving account state.`)
            }

            if (account.storageProof.length > 0) {
              this.logger.interesting(`Moving on to prove storage slots for the account.`)
            }
      
            for (const slot of account.storageProof) {
              this.logger.info(`Trying to prove the value of slot: ${slot.key}`)
              this.logger.info(`Value is: ${slot.value}`)

              this.logger.info(`Checking if we've already proven the given storage slot: ${slot.key}...`)
              const existingSlotValue = await OVM_StateManager.getContractStorage(
                account.address,
                slot.key,
              )
              
              if (existingSlotValue === '0x' + slot.value.slice(2).padStart(64, '0')) {
                this.logger.info(`Slot value has already been proven, skipping.`)
              } else {
                this.logger.info(`Slot value has not been proven, attempting to prove it now...`)
                await OVM_StateTransitioner.connect(this.options.l1Wallet).proveStorageSlot(
                  account.address,
                  '0x' + slot.key.slice(2).padStart(64, '0'),
                  '0x' + slot.value.slice(2).padStart(64, '0'),
                  rlp.encode(slot.proof)
                )
                this.logger.success(`Proved storage slot value, moving on to the next slot.`)
              }
            }
          }


          // 5. Execute the transaction.
          
          this.logger.interesting(`Finished proving all values. Executing transaction...`)
          await OVM_StateTransitioner.connect(this.options.l1Wallet).applyTransaction(proof.transactionProof.transaction, {
            gasLimit: 8_000_000
          })
          this.logger.success(`Transaction successfully executed.`)
        }

        if (
          (await OVM_StateTransitioner.phase()) ===
          StateTransitionPhase.POST_EXECUTION
        ) {
          this.logger.interesting(`Fraud proof is now in the POST_EXECUTION phase.`)

          // 6. Update all of the modified storage slots and accounts.
          const mutatedAccounts = proof.proof.accounts.filter((account) => {
            return true
          })

          for (const account of mutatedAccounts) {
            this.logger.info(`Account was changed during execution: ${account.address}`)
            this.logger.info(`Pulling account state from state manager...`)
            const newAccountASDF = await OVM_StateManager.getAccount(
              account.address
            )

            const newAccount = {
              nonce: newAccountASDF.nonce.toNumber(),
              balance: newAccountASDF.balance,
              storageRoot: newAccountASDF.storageRoot,
              codeHash: newAccountASDF.codeHash,
            }

            const oldAccountState = decodeAccountState(
              await proof.stateTrie.get(
                fromHexString(ethers.utils.keccak256(account.address))
              )
            )

            if (encodeAccountState(oldAccountState) === encodeAccountState(newAccount)) {
              this.logger.info(`Account was not changed, skipping...`)
              continue
            }

            if (oldAccountState.nonce !== newAccount.nonce) {
              const updateProof = await updateAndProve(
                proof.stateTrie,
                fromHexString(ethers.utils.keccak256(account.address)),
                encodeAccountState({
                  ...oldAccountState,
                  ...{
                    nonce: newAccount.nonce,
                    codeHash: newAccount.codeHash,
                  },
                })
              )

              this.logger.info(`Trying to commit the updated account state...`)
              try {
                await OVM_StateTransitioner.connect(this.options.l1Wallet).commitContractState(
                  account.address,
                  updateProof,
                  {
                    gasLimit: this.options.deployGasLimit,
                  }
                )
              } catch (err) {
                if (!err.toString().includes('was not changed or has already')) {
                  throw err
                } else {
                  console.log('??????')
                }
              }
              this.logger.success(`Updated account state committed, moving on to storage slots.`)
            }

            const mutatedSlots = account.storageProof.filter((slot) => {
              return true
            })

            if (mutatedSlots.length === 0) {
              this.logger.info(`Account does not have any mutated storage slots, skipping.`)
            }


            const oldAccountState2 = decodeAccountState(
              await proof.stateTrie.get(
                fromHexString(ethers.utils.keccak256(account.address))
              )
            )

            for (const slot of mutatedSlots) {
              this.logger.info(`Slot was mutated: ${slot.key}`)
  
              const trie = proof.storageTries[account.address]

              this.logger.info(`Pulling the new slot value...`)
              const updatedSlotValue = await OVM_StateManager.getContractStorage(
                account.address,
                slot.key
              )

              console.log(await OVM_StateManager.getTotalUncommittedContractStorage())
              console.log(account.address, slot.key, updatedSlotValue)

              if (updatedSlotValue === '0x' + slot.value.slice(2).padStart(64, '0') && (account.address !== '0x4200000000000000000000000000000000000006' && account.address !== '0x06a506a506a506a506a506a506a506a506a506a5')) {
                this.logger.info(`Slot already updated, skipping...`)
                continue
              }

              const storageTrieProof = await updateAndProve(
                trie,
                fromHexString(ethers.utils.keccak256(slot.key)),
                fromHexString(rlp.encode(updatedSlotValue))
              )

              const newAccountState = {
                ...oldAccountState2,
                storageRoot: toHexString(trie.root),
              }

              const stateTrieProof = await updateAndProve(
                proof.stateTrie,
                fromHexString(ethers.utils.keccak256(account.address)),
                encodeAccountState(newAccountState)
              )

              this.logger.info(`Trying to commit the new slot value...`)
              console.log(account.address, slot.key)
              try {
                await OVM_StateTransitioner.connect(this.options.l1Wallet).commitStorageSlot(
                  account.address,
                  slot.key,
                  stateTrieProof,
                  storageTrieProof,
                  {
                    gasLimit: this.options.deployGasLimit,
                  }
                )
              } catch (err) {
                if (!err.toString().includes('not changed or has already been')) {
                  throw err
                } else {
                  console.log('???????????')
                }
              }
              this.logger.success(`New slot value committed successfully.`)
            }
          }

          // 7. Complete the process in the state transitioner.
          this.logger.success(`All updates were committed. Completing the state transition...`)
          await OVM_StateTransitioner.connect(this.options.l1Wallet).completeTransition()
          this.logger.success(`State transition completed.`)
        }

        if (
          (await OVM_StateTransitioner.phase()) ===
          StateTransitionPhase.COMPLETE
        ) {
          this.logger.interesting(`Fraud proof is now in the COMPLETE phase.`)
          this.logger.info(`Attempting to finalize the fraud proof...`)
          // 8. Finalize the process in the fraud verifier.
          await this._finalizeFraudVerification(proof)
          this.logger.success(`Fraud proof finalized! Congrats.`)
        }
      } catch (err) {
        this.logger.error(
          `Caught an unhandled error, see error log below:\n\n${err}\n`
        )
      }
    }
  }

  private async _getTxFraudProofData(
    transactionIndex: number
  ): Promise<FraudProofData> {
    const proof: StateDiffProof = await this.state.l2Provider.getStateDiffProof(
      transactionIndex + this.options.l2BlockOffset
    )
    
    const senderProof = await this.state.l2Provider.getProof(
      transactionIndex + this.options.l2BlockOffset, '0xe84578fbA927D32760CB978C32bAd03069cCbDD2', ['0x0000000000000000000000000000000000000000000000000000000000000000']
    )

    proof.accounts.push(senderProof)


    const gasProof = await this.state.l2Provider.getProof(
      transactionIndex + this.options.l2BlockOffset, '0x06a506a506a506a506a506a506a506a506a506a5', ['0x0000000000000000000000000000000000000000000000000000000000000002']
    )

    const acc = proof.accounts.find((account) => {
      return account.address === '0x06a506a506a506a506a506a506a506a506a506a5'
    })
    
    acc.storageProof = acc.storageProof.concat(gasProof.storageProof)

    const entrypointProof = await this.state.l2Provider.getProof(
      transactionIndex + this.options.l2BlockOffset, '0x4200000000000000000000000000000000000005', []
    )

    proof.accounts.push(entrypointProof)

    const ecdsaProof = await this.state.l2Provider.getProof(
      transactionIndex + this.options.l2BlockOffset, '0x4200000000000000000000000000000000000003', []
    )

    proof.accounts.push(ecdsaProof)

    const preStateRootIndex = transactionIndex
    const preStateRoot = await this.state.l2Provider.getStateRoot(
      preStateRootIndex + this.options.l2BlockOffset
    )
    const preStateRootProof = await this.state.l1Provider.getStateRootBatchProof(
      preStateRootIndex
    )

    const postStateRootIndex = transactionIndex + 1
    const postStateRoot = await this.state.l2Provider.getStateRoot(
      postStateRootIndex + this.options.l2BlockOffset
    )
    const postStateRootProof = await this.state.l1Provider.getStateRootBatchProof(
      postStateRootIndex
    )

    const transaction = await this.state.l2Provider.getTransaction(
      transactionIndex + this.options.l2BlockOffset
    )
    const transactionProof = await this.state.l1Provider.getTransactionBatchProof(
      transactionIndex
    )

    const stateTrie = await this._makeStateTrie(proof)
    const storageTries = await this._makeAccountTries(proof)

    return {
      proof,
      transaction,
      transactionIndex,
      transactionProof,
      preStateRoot,
      preStateRootIndex,
      preStateRootProof,
      postStateRoot,
      postStateRootIndex,
      postStateRootProof,
      stateTrie,
      storageTries,
    }
  }

  private async _makeStateTrie(proof: StateDiffProof): Promise<BaseTrie> {
    const firstRootNode = proof.accounts[0].accountProof[0]
    const allNonRootNodes: string[] = proof.accounts.reduce(
      (nodes, account) => {
        return nodes.concat(account.accountProof.slice(1))
      },
      []
    )
    const allNodes = [firstRootNode].concat(allNonRootNodes).map((el) => {
      return Buffer.from(el.slice(2), 'hex')
    })

    return BaseTrie.fromProof(allNodes)
  }

  private async _makeAccountTries(
    proof: StateDiffProof
  ): Promise<{
    [address: string]: SecureTrie
  }> {
    const witnessMap = proof.accounts.reduce(
      (
        map: {
          [address: string]: Buffer[]
        },
        account
      ) => {
        const ovmContractAddress = account.address
        if (!(ovmContractAddress in map)) {
          if (account.storageProof.length > 0) {
            if (account.storageProof[0].proof.length > 0) {
              map[ovmContractAddress] = [
                Buffer.from(account.storageProof[0].proof[0].slice(2), 'hex'),
              ]
            } else {
              map[ovmContractAddress] = []
            }
          } else {
            map[ovmContractAddress] = []
          }
        }

        map[ovmContractAddress] = map[ovmContractAddress].concat(
          account.storageProof.reduce((nodes, storageProof) => {
            nodes = nodes.concat(storageProof.proof.slice(1).map((el) => {
              return Buffer.from(el.slice(2), 'hex')
            }))

            return nodes
          }, [])
        )

        return map
      },
      {}
    )

    const accountTries = {}
    for (const ovmContractAddress of Object.keys(witnessMap)) {
      const proof = witnessMap[ovmContractAddress]
      accountTries[ovmContractAddress] = await BaseTrie.fromProof(proof)
    }

    return accountTries
  }

  private async _getStateTransitioner(
    preStateRoot: string,
    transaction: SequencerTransaction,
  ): Promise<string> {
    const toHexString32 = (num: number): string => {
      return toHexStringN(num, 32)
    }

    const toHexString1 = (num: number): string => {
      return toHexStringN(num, 1)
    }

    const toHexStringN = (num: number, n: number): string => {
      return '0x' + BigNumber.from(num).toHexString().slice(2).padStart(n * 2, '0')
    }

    const encodedTx = toHexString(Buffer.concat([
      fromHexString(toHexString32(transaction.timestamp)),
      fromHexString(toHexString32(transaction.blockNumber)),
      fromHexString(toHexString1(transaction.l1QueueOrigin)),
      fromHexString(transaction.l1TxOrigin),
      fromHexString(transaction.entrypoint),
      fromHexString(toHexString32(transaction.gasLimit)),
      fromHexString(transaction.data),
    ]))

    const hashedTx = ethers.utils.keccak256(encodedTx)

    return this.state.OVM_FraudVerifier.getStateTransitioner(preStateRoot, hashedTx)
  }

  /**
   * Simple mechanism for deploying an exact bytecode to a given address. Resulting contract will
   * have code exactly matching the given `code` variable, and none of the code will be executed
   * during creation.
   * @param code Code to store at a given address.
   * @return Address of the newly created contract.
   */
  private async _deployContractCode(code: string): Promise<string> {
    // "Magic" prefix to be prepended to the contract code. Contains a series of opcodes that will
    // copy the given code into memory and return it, thereby storing at the contract address.
    const prefix = '0x600D380380600D6000396000f3'
    const deployCode = prefix + toHexString(code).slice(2)

    const response = await this.options.l1Wallet.sendTransaction({
      to: null,
      data: deployCode,
      gasLimit: this.options.deployGasLimit,
    })

    const result = await response.wait()
    return result.contractAddress
  }

  private async _initializeFraudVerification(
    proof: FraudProofData
  ): Promise<void> {
    await this.state.OVM_FraudVerifier.connect(this.options.l1Wallet).initializeFraudVerification(
      proof.preStateRootProof.stateRoot,
      proof.preStateRootProof.stateRootBatchHeader,
      proof.preStateRootProof.stateRootProof,
      proof.transactionProof.transaction,
      proof.transactionProof.transactionChainElement,
      proof.transactionProof.transactionBatchHeader,
      proof.transactionProof.transactionProof
    )
  }

  private async _finalizeFraudVerification(
    proof: FraudProofData
  ): Promise<void> {
    const transaction = proof.transactionProof.transaction
    const toHexString32 = (num: number): string => {
      return toHexStringN(num, 32)
    }

    const toHexString1 = (num: number): string => {
      return toHexStringN(num, 1)
    }

    const toHexStringN = (num: number, n: number): string => {
      return '0x' + BigNumber.from(num).toHexString().slice(2).padStart(n * 2, '0')
    }

    const encodedTx = toHexString(Buffer.concat([
      fromHexString(toHexString32(transaction.timestamp)),
      fromHexString(toHexString32(transaction.blockNumber)),
      fromHexString(toHexString1(transaction.l1QueueOrigin)),
      fromHexString(transaction.l1TxOrigin),
      fromHexString(transaction.entrypoint),
      fromHexString(toHexString32(transaction.gasLimit)),
      fromHexString(transaction.data),
    ]))

    const hashedTx = ethers.utils.keccak256(encodedTx)

    await this.state.OVM_FraudVerifier.connect(this.options.l1Wallet).finalizeFraudVerification(
      proof.preStateRootProof.stateRoot,
      proof.preStateRootProof.stateRootBatchHeader,
      proof.preStateRootProof.stateRootProof,
      hashedTx,
      proof.postStateRootProof.stateRoot,
      proof.postStateRootProof.stateRootBatchHeader,
      proof.postStateRootProof.stateRootProof
    )
  }
}
