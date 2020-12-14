#!/usr/bin/env node

const main = require("../build/exec/run-fraud-prover").default

;(async () => {
  await main()
})().catch((err) => {
  console.log(err)
  process.exit(1)
})
