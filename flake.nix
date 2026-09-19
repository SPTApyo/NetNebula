{
  description = "NetNebula — Python crawler and Firebase Hosting viewer";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Crawler dependencies, all present in nixpkgs: no venv and no pip to
      # manage. lxml and python-dotenv are optional at runtime, but shipping
      # them here means the shell matches requirements.txt exactly.
      pythonFor = pkgs: pkgs.python3.withPackages (ps: with ps; [
        aiohttp
        beautifulsoup4
        lxml
        tldextract
        firebase-admin
        loguru
        python-dotenv
      ]);

      # Everything local: the Firestore emulator holds the database, the
      # Hosting emulator serves public/. No service account, no quota, and no
      # network once the jars are downloaded. The viewer switches over on its
      # own as soon as it is served from localhost (see LOCAL in public/app.js).
      localFor = pkgs: pkgs.writeShellScriptBin "netnebula-local" ''
        # The database lives in .emulator/: it survives a shutdown, so we do
        # not recrawl on every launch. Nothing is there to import on the first
        # start, hence the conditional --import.
        data=".emulator"
        args=(--only firestore,hosting --project netnebula-local
              --export-on-exit "$data")
        [ -d "$data" ] && args+=(--import "$data")
        exec ${pkgs.firebase-tools}/bin/firebase emulators:start "''${args[@]}" "$@"
      '';
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            (pythonFor pkgs)
            pkgs.firebase-tools
            pkgs.nodejs_22
            # The Firestore and Auth emulators run on the JVM, and
            # firebase-tools refuses any version older than 21.
            pkgs.openjdk21
            (localFor pkgs)
          ];

          # tldextract wants a writable cache directory; the store is not one.
          # The crawler uses the bundled snapshot of the public suffix list,
          # but the library creates that directory on startup regardless.
          TLDEXTRACT_CACHE = "./.cache/tldextract";

          shellHook = ''
            echo "NetNebula — $(firebase --version 2>/dev/null || echo 'firebase ?') · $(python --version)"
            echo
            echo "  Local, no quota               (throwaway database in the emulator)"
            echo "    netnebula-local                            http://localhost:5000"
            echo "    export FIRESTORE_EMULATOR_HOST=127.0.0.1:8088"
            echo "    python scrapper/crawler.py"
            echo
            echo "  Production                    (service account key required)"
            echo "    cp scrapper/.env.example scrapper/.env    # then set the key path"
            echo "    python scrapper/crawler.py --status"
            echo "    firebase deploy --only hosting,firestore:rules"
            echo
            echo "  Tests"
            echo "    python scrapper/test_crawler.py"
            echo "    nix flake check"
            echo
          '';
        };
      });

      # `nix flake check` runs the crawler tests. They are written without
      # network or Firestore access, so they pass inside the Nix sandbox.
      checks = forAllSystems (pkgs: {
        crawler = pkgs.runCommand "netnebula-crawler-tests"
          {
            nativeBuildInputs = [ (pythonFor pkgs) ];
            src = ./scrapper;
          }
          ''
            cp -r "$src" ./scrapper && chmod -R +w ./scrapper && cd ./scrapper
            export TLDEXTRACT_CACHE="$PWD/.cache"
            python test_crawler.py
            touch "$out"
          '';
      });

      formatter = forAllSystems (pkgs: pkgs.nixpkgs-fmt);
    };
}
