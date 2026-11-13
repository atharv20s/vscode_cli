#!/usr/bin/env bash
set -e
cd /home/ubuntu/ath-ide/server
node --input-type=module -e 'import { chromium } from "playwright"; const b = await chromium.launch({headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]}); console.log("Chromium launched version:", b.version()); await b.close();'

