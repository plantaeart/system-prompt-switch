{
  description = "system-prompt-switch dev shell (bun, node, uv; `.#e2e` adds pinned Pi/OMP CLIs)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Host CLIs the e2e smoke test spawns. Single source of truth for the pins:
      # CI uses this shell, and .agents/skills/host-version/scripts/check-host-versions.sh
      # greps these exact `name@version` strings.
      hostCLIs = [
        "@earendil-works/pi-coding-agent@1.5.0"
        "@oh-my-pi/pi-coding-agent@18.16.0"
      ];

      # shortcut: nixpkgs lags bun releases, so override to the version CI pinned.
      # Bump version + hashes together (nix store prefetch-file <url>).
      bunVersion = "1.4.4";
      bunHashes = {
        aarch64-darwin = { asset = "bun-darwin-aarch64"; hash = "sha256-wkDX8My5DCY6hJ/NsJt+5iYw2SE0jtaq/ahrnVd7xRA="; };
        aarch64-linux = { asset = "bun-linux-aarch64"; hash = "sha256-uqa7NvUdblhWHgK76oJQOKnfRU9nPW13bou/hvjHhQ4="; };
        x86_64-linux = { asset = "bun-linux-x64-baseline"; hash = "sha256-4ERutVmVdy65iUvrrppr42jZhai5Jx7hJEhvmUbu3XY="; };
      };
    in
    {
      devShells = forAllSystems (pkgs:
        let
          src = bunHashes.${pkgs.stdenv.hostPlatform.system};
          bun = pkgs.bun.overrideAttrs (_: {
            version = bunVersion;
            src = pkgs.fetchurl {
              url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${src.asset}.zip";
              inherit (src) hash;
            };
          });
          packages = [ bun pkgs.nodejs_26 pkgs.uv ];
        in
        {
          # Day-to-day development (direnv): no host CLIs installed.
          default = pkgs.mkShell { inherit packages; };

          # Tests / CI: `nix develop .#e2e`. Adds the pinned Pi/OMP CLIs.
          e2e = pkgs.mkShell {
            inherit packages;

            # Idempotent: installs the pinned CLIs into .direnv/host-cli once.
            # nix-direnv caches this hook; after deleting .direnv run `nix-direnv-reload`.
            shellHook = ''
              export HOST_CLI_PREFIX="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.direnv/host-cli"
              export PATH="$HOST_CLI_PREFIX/bin:$PATH"
              stamp="${builtins.concatStringsSep " " hostCLIs}"
              if [ "$(cat "$HOST_CLI_PREFIX/.stamp" 2>/dev/null)" != "$stamp" ]; then
                echo "Installing pinned Pi/OMP CLIs into .direnv/host-cli ..." >&2
                npm install -g --prefix "$HOST_CLI_PREFIX" ${builtins.concatStringsSep " " hostCLIs} >&2 \
                  && echo "$stamp" > "$HOST_CLI_PREFIX/.stamp"
              fi
            '';
          };
        });
    };
}
