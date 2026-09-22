# Encrypted secrets (sops + age)

Real credentials/config for local setup are kept **encrypted** in this repo so changes
stay tracked in git history without exposing plaintext values. Encryption rules live in
`.sops.yaml` at repo root.

Encrypted files:

- `docs/setup/config_local.json.enc`
- `docs/setup/config_prod.json.enc`
- `docs/web-docs/setup/env.local.enc` (was `.env.local`)
- `docs/web-docs/setup/env.new.bak.enc` (was `.env.new.bak`)

The matching plaintext files (`.env.local`, `.env.new.bak`, `config_local.json`,
`config_prod.json`, `*.sql`) are gitignored and must never be committed.

## One-time setup (new machine)

```bash
brew install sops age
mkdir -p ~/.config/sops/age
# copy your existing age private key to ~/.config/sops/age/keys.txt
# (the key is NOT in this repo — get it from your password manager / backup)
chmod 600 ~/.config/sops/age/keys.txt
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt   # add to your shell profile
```

## Decrypt to use locally

```bash
sops --input-type json --output-type json --decrypt docs/setup/config_local.json.enc > docs/setup/config_local.json
sops --input-type json --output-type json --decrypt docs/setup/config_prod.json.enc  > docs/setup/config_prod.json
sops --input-type dotenv --output-type dotenv --decrypt docs/web-docs/setup/env.local.enc     > docs/web-docs/setup/.env.local
sops --input-type dotenv --output-type dotenv --decrypt docs/web-docs/setup/env.new.bak.enc    > docs/web-docs/setup/.env.new.bak
```

## Edit / rotate a value

Edit in place (opens decrypted in `$EDITOR`, re-encrypts on save — never leaves plaintext on disk):

```bash
sops --input-type json --output-type json docs/setup/config_local.json.enc
sops --input-type dotenv --output-type dotenv docs/web-docs/setup/env.local.enc
```

Commit the `.enc` file afterwards — `git diff` / `git log -p` on it will show which
**keys** changed (values stay ciphertext, so diffs are safe to view even over someone's
shoulder).

## Adding a new secret file

1. Add a `path_regex` entry to `.sops.yaml` pointing at the new `*.enc` filename.
2. `cp real-file.ext real-file.ext.enc`
3. `sops --input-type <json|dotenv> --output-type <json|dotenv> --encrypt --in-place real-file.ext.enc`
4. Add the plaintext pattern to `.gitignore` if not already covered.
