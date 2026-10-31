#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${ROOT_DIR}/.venv"

pick_python() {
  local c
  for c in python3.13 python3.12 python3.11 python3.10 python3.9 python3 python; do
    if command -v "$c" >/dev/null 2>&1; then
      "$c" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 9) else 1)
PY
      if [[ $? -eq 0 ]]; then
        echo "$c"
        return 0
      fi
    fi
  done
  return 1
}

if [[ -n "${REPO2LORA_WHEEL:-}" ]]; then
  WHEEL_PATH="${REPO2LORA_WHEEL}"
else
  WHEEL_PATH="$(find "${ROOT_DIR}" -maxdepth 1 -type f -name 'repo2lora-*.whl' | sort -V | tail -n 1 || true)"
fi

if [[ -z "${WHEEL_PATH}" ]]; then
  echo "No wheel found in ${ROOT_DIR}. Put repo2lora-<version>-py3-none-any.whl here or set REPO2LORA_WHEEL." >&2
  exit 1
fi

PY_CMD="$(pick_python || true)"
if [[ -z "${PY_CMD}" ]]; then
  echo "No Python >=3.9 interpreter found on PATH." >&2
  exit 1
fi

echo "Using Python: ${PY_CMD}"
echo "Using wheel: ${WHEEL_PATH}"

if [[ ! -d "${VENV_DIR}" ]]; then
  "${PY_CMD}" -m venv "${VENV_DIR}"
fi

"${VENV_DIR}/bin/python" -m pip install --upgrade pip setuptools wheel
"${VENV_DIR}/bin/python" -m pip install --upgrade "${WHEEL_PATH}"

# Optional deps for parser/tokenizer features.
"${VENV_DIR}/bin/python" -m pip install --upgrade \
  "tree-sitter>=0.23" \
  tree-sitter-javascript \
  tree-sitter-typescript \
  transformers

"${VENV_DIR}/bin/repo2lora" --version
"${VENV_DIR}/bin/repo2lora" doctor --repo "${ROOT_DIR}" || true

echo
echo "Done. To use manually:"
echo "  source ${VENV_DIR}/bin/activate"
echo "  repo2lora --version"
