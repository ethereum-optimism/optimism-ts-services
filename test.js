const ethers = require('ethers')

const sleep = async (ms) => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}


const main = async () => {
  const provider = new ethers.providers.JsonRpcProvider('http://localhost:8545')

  while (true) {
    const num = '0x' + (new ethers.BigNumber.from(3)).toHexString().slice(2).replace(/^0+/, '')
    const block = await provider.send('eth_getBlockByNumber', [num, false])
    if (block) {
      console.log(block.stateRoot)
    } else {
      console.log('waiting for block to exist')
    }

    await sleep(1000)
  }
}

main()
