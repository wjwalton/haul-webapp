# Firmware images (not in git)

This folder is where the official images go for a build that includes them:

| File | Size | SHA-256 |
|---|---|---|
| `M1B0306s0.bin` (controller) | 81,920 B | `e7e308034972da1604a72676acc05fdb45bbbdbb15947ef88d99052a71e9f6e4` |
| `EH02_Eagotech_5.19.zip` (HMI) | 98,963 B | `1c8f1374bb929d8b8176fd19b8bf81726fe4bbf0b42939793dac8afd66d715d2` |
| `F.00.00G1.B.02.A12_V01.00.12.bin` (battery, RC line) | 107,336 B | `2c3821a26eae19ed3d276ab43b97dbf5564d3825327baf2d69f7c21a5832d751` |
| `F.00.00G1.B.01.A08_V01.00.08.bin` (battery, SC line) | 108,728 B | `aae2884bbe92492dd2956221650b82f755a3ad9d863ce55b24203166a8174465` |

They are Specialized's files and are never committed (`.gitignore`). Nothing else may be placed here.
Without them the app still builds and runs; the update screens then load the file from disk, and only
these files (by full SHA-256) are accepted.
