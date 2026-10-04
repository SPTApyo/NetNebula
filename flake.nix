{
  description = "NetNebula: Common Crawl domain graph and Firebase Hosting viewer";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      pythonFor = pkgs: pkgs.python3.withPackages (ps: [ ps.igraph ]);
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.uv
            pkgs.python313
            pkgs.firebase-tools
            pkgs.nodejs_22
          ];

          # igraph wheels from PyPI link against libstdc++.
          LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ];
          UV_PYTHON_DOWNLOADS = "never";

          shellHook = ''
            echo "NetNebula: $(firebase --version 2>/dev/null || echo 'firebase ?') · $(python --version)"
            echo
            echo "  npm run test          # pipeline tests"
            echo "  npm run graph:small   # 2,000-domain graph"
            echo "  npm run serve         # http://localhost:5000"
            echo
          '';
        };
      });

      checks = forAllSystems (pkgs: {
        pipeline = pkgs.runCommand "netnebula-pipeline-tests"
          {
            nativeBuildInputs = [ (pythonFor pkgs) ];
            src = ./pipeline;
          }
          ''
            cd "$src"
            python -B test_build_graph.py
            touch "$out"
          '';
      });

      formatter = forAllSystems (pkgs: pkgs.nixpkgs-fmt);
    };
}
