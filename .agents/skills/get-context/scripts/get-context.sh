#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../../.." && pwd)"

echo "============================================================"
echo " SYSTEM PROMPT SWITCH - PLUGIN CONTEXT"
echo "============================================================"
echo "Project Root: ${ROOT_DIR}"
echo ""

echo "--- Technologies & Runtimes ---"
if command -v bun >/dev/null 2>&1; then
  echo "• Bun: $(bun --version)"
fi
if command -v node >/dev/null 2>&1; then
  echo "• Node: $(node --version)"
fi
if command -v pi >/dev/null 2>&1; then
  echo "• Pi Coding Agent: $(pi --version)"
fi
if command -v omp >/dev/null 2>&1; then
  echo "• Omp: $(omp --version)"
fi
echo "• Language: TypeScript (ESNext, Bundler resolution)"
echo "• Architecture: Hexagonal (Ports & Adapters)"
echo ""

echo "--- Package Information ---"
if [ -f "${ROOT_DIR}/package.json" ]; then
  NAME=$(grep -o '"name": *"[^"]*"' "${ROOT_DIR}/package.json" | cut -d'"' -f4)
  VERSION=$(grep -o '"version": *"[^"]*"' "${ROOT_DIR}/package.json" | cut -d'"' -f4)
  echo "• Name: ${NAME}"
  echo "• Version: ${VERSION}"
fi
echo ""

echo "--- Available NPM / Bun Scripts ---"
if [ -f "${ROOT_DIR}/package.json" ]; then
  sed -n '/"scripts": {/,/}/p' "${ROOT_DIR}/package.json" | grep -v '"scripts":' | grep -v '}' | sed 's/[",]//g' | sed 's/^ */  • /' || echo "  (none)"
fi
echo ""

echo "--- Pi Extension Commands ---"
cat << 'EOF'
  • /sps-select : Pick active prompt for the current session (or None / Default)
  • /sps-inject : Cumulatively stack/inject multiple system prompts
  • /sps-new    : Create a new system prompt markdown file directly in OMP
  • /sps-edit   : Edit an existing system prompt in OMP's built-in editor
  • /sps-path   : Display absolute local and global file paths for system prompts
  • /sps-delete : Delete an existing prompt file
  • /sps-move   : Move a prompt file to another scope (local, pi, omp)
  • /sps-mode   : Toggle or set prompt injection mode (append | replace)
  • /sps-info   : Display current session prompt, mode, and session ID
  • /sps-logs   : Display recent session logs and live tail command
EOF
echo ""

echo "--- Available Skills (.agents/skills/) ---"
SKILLS_DIR="${ROOT_DIR}/.agents/skills"
if [ -d "${SKILLS_DIR}" ]; then
  for skill in "${SKILLS_DIR}"/*; do
    if [ -d "${skill}" ]; then
      skill_name=$(basename "${skill}")
      desc="No description"
      if [ -f "${skill}/SKILL.md" ]; then
        # Prefer the frontmatter description; fall back to the first prose line
        # for skills written before frontmatter was required.
        desc=$(sed -n 's/^description:[[:space:]]*//p' "${skill}/SKILL.md" | head -n 1)
        if [ -z "${desc}" ]; then
          desc=$(sed -n '/^---$/,/^---$/!p' "${skill}/SKILL.md" \
            | grep -v '^#' | grep -v '^$' | head -n 1 || echo "")
        fi
        [ -n "${desc}" ] || desc="No description"
      fi
      echo "  • ${skill_name}: ${desc}"
    fi
  done
else
  echo "  (none found)"
fi
echo ""

echo "--- Directory Structure ---"
find "${ROOT_DIR}" -maxdepth 3 -not -path '*/.*' -not -path '*/node_modules*' | sort | sed "s#^${ROOT_DIR}/##" | sed 's/^/  /'
echo "============================================================"
