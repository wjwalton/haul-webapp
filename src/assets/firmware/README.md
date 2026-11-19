# Firmware images (not in git)

This folder is where the two official images go for a build that includes them:

| File | Size | SHA-256 |
|---|---|---|
| `M1B0306s0.bin` (controller) | 81,920 B | `e7e308034972da1604a72676acc05fdb45bbbdbb15947ef88d99052a71e9f6e4` |
| `EH02_Eagotech_5.19.zip` (HMI) | 98,963 B | `1c8f1374bb929d8b8176fd19b8bf81726fe4bbf0b42939793dac8afd66d715d2` |

They are Specialized's files and are never committed (`.gitignore`). Nothing else may be placed here.
Without them the app still builds and runs; the update screens then load the file from disk, and only
these two files (by full SHA-256) are accepted.
