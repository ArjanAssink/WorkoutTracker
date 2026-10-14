#!/usr/bin/env bash
#
# The monthly ritual, as one command.
#
# Finds the Apple Health export, unzips it, fetches the storage connection string from
# Azure if it is not already set, imports, and removes the extracted copy afterwards —
# export.xml is your complete medical history and should not linger in Downloads.
#
#   npm run sync                      # newest apple_health_export*.zip in ~/Downloads
#   npm run sync -- ~/path/export.zip # or point it at one
#   npm run sync -- --dry-run         # parse and report, write nothing
#   npm run sync -- --max-hr          # just print the highest heart rate in the export
#
set -euo pipefail
cd "$(dirname "$0")/.."

# Azure names come from the gitignored .env (see .env.example), never from this file.
[ -f .env ] && { set -a; . ./.env; set +a; }
RESOURCE_GROUP="${RESOURCE_GROUP:-${AZURE_RESOURCE_GROUP:?set AZURE_RESOURCE_GROUP in .env}}"
STORAGE_ACCOUNT="${STORAGE_ACCOUNT:-${AZURE_STORAGE_ACCOUNT:?set AZURE_STORAGE_ACCOUNT in .env}}"

ARCHIVE=""
PASSTHROUGH=()
MAX_HR_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --max-hr) MAX_HR_ONLY=true ;;
    --*)      PASSTHROUGH+=("$arg") ;;
    *)        ARCHIVE="$arg" ;;
  esac
done

# 1. Locate the export ---------------------------------------------------------
if [ -z "$ARCHIVE" ]; then
  # -t sorts newest first; the glob may match nothing, hence the 2>/dev/null.
  ARCHIVE=$(ls -t ~/Downloads/apple_health_export*.zip ~/Downloads/export*.zip 2>/dev/null | head -1 || true)
fi
if [ -z "$ARCHIVE" ] || [ ! -e "$ARCHIVE" ]; then
  cat >&2 <<'MSG'
No Health export found.

On the iPhone: Health -> your avatar (top right) -> Export All Health Data.
AirDrop the zip to this machine, then re-run. It looks in ~/Downloads by default,
or pass a path:  npm run sync -- /path/to/export.zip
MSG
  exit 1
fi
echo "Export: $ARCHIVE"

# 2. Extract to a temp dir that is always cleaned up ---------------------------
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if [ "${ARCHIVE##*.}" = "zip" ]; then
  # Only export.xml. The zip also carries export_cda.xml — a clinical-document rendering
  # of the same data, often over a gigabyte — which nothing here reads.
  echo "Extracting export.xml and the workout routes..."
  unzip -q "$ARCHIVE" '*export.xml' '*workout-routes/*' -d "$WORK"
  XML=$(find "$WORK" -name export.xml -maxdepth 3 | head -1)
else
  XML="$ARCHIVE"
fi
if [ -z "${XML:-}" ] || [ ! -f "$XML" ]; then
  echo "Could not find export.xml inside $ARCHIVE" >&2
  exit 1
fi

# 3. --max-hr: answer the one question the export can answer and stop ----------
if [ "$MAX_HR_ONLY" = true ]; then
  echo
  echo "Highest per-workout maximum heart rates in this export:"
  grep -o 'maximum="[0-9.]*"' "$XML" | grep -o '[0-9.]*' | sort -rn | head -10 \
    | awk 'NR==1{printf "  %d bpm   <- highest\n",$1; next} {printf "  %d bpm\n",$1}'
  echo
  echo "Set ATHLETE_MAX_HR in .env to the highest value you trust as a real effort,"
  echo "not a sensor spike — compare the top few."
  exit 0
fi

# 4. Storage connection --------------------------------------------------------
if [ -z "${WORKOUTS_STORAGE:-}" ] && [ -z "${AzureWebJobsStorage:-}" ]; then
  # A dry run writes nothing, so it does not need credentials.
  if [[ " ${PASSTHROUGH[*]:-} " != *" --dry-run "* ]]; then
    echo "Fetching storage connection string from Azure..."
    WORKOUTS_STORAGE=$(az storage account show-connection-string \
      -g "$RESOURCE_GROUP" -n "$STORAGE_ACCOUNT" --query connectionString -o tsv)
    export WORKOUTS_STORAGE
  fi
fi

# 5. Import --------------------------------------------------------------------
npm run import --silent -- "$XML" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}

echo
echo "Extracted copy removed. The original zip is still at:"
echo "  $ARCHIVE"
echo "Delete it when you are done — it is your full medical history."
