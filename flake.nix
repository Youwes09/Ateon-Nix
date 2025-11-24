{
  description = "Ateon: A Material Design desktop shell for Hyprland powered by AGS, Astal & Chromash";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    systems.url = "github:nix-systems/default";

    astal = {
      url = "github:aylur/astal";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    ags = {
      url = "github:aylur/ags";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.astal.follows = "astal";
    };

    matugen = {
      url = "github:InioX/matugen";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    chromash = {
      url = "github:Youwes09/Chromash";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs @ {
    self,
    nixpkgs,
    astal,
    ags,
    systems,
    flake-parts,
    ...
  }: let
    mkPkgs = system:
      import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      };

    # Core AGS/Astal build dependencies
    mkCoreBuildInputs = system: let
      pkgs = mkPkgs system;
      astalPkgs = astal.packages.${system};
    in
      (with pkgs; [
        glib
        gjs
        typescript
        libgtop
        libadwaita
        libsoup_3
        glib-networking
      ])
      ++ (with astalPkgs; [
        astal4
        io
        notifd
        apps
        wireplumber
        mpris
        network
        tray
        bluetooth
        battery
        powerprofiles
        hyprland
      ]);

    # Runtime dependencies that need to be in PATH
    mkRuntimeDeps = system: let
      pkgs = mkPkgs system;
      matugenPackage = inputs.matugen.packages.${system}.default;
      chromashPackage = inputs.chromash.packages.${system}.default;
    in
      with pkgs; [
        # Core utilities
        dart-sass
        imagemagick
        libnotify
        wl-clipboard
        cliphist
        brightnessctl
        
        # Hyprland ecosystem
        hyprpaper
        
        # System services
        bluez
        networkmanager
        
        # Screenshot & color picker
        grim
        slurp
        hyprpicker
        swappy
        
        # Media control
        playerctl
        
        # Python for various tools
        python3
        
        # Theming tools
        matugenPackage
        chromashPackage
      ];

    # Icon and font packages
    mkIconsAndFonts = system: let
      pkgs = mkPkgs system;
    in
      with pkgs; [
        adwaita-icon-theme
        material-design-icons
        material-symbols
        hicolor-icon-theme
        gnome-themes-extra
      ];

    mkAteonPackage = system: let
      pkgs = mkPkgs system;
      agsPackage = ags.packages.${system}.default;
      runtimeDeps = mkRuntimeDeps system;
      iconsAndFonts = mkIconsAndFonts system;
    in let
      ateon-bundle = pkgs.stdenv.mkDerivation {
        pname = "ateon-bundle";
        version = "1.0.0";

        src = ./ags;

        nativeBuildInputs = with pkgs; [
          wrapGAppsHook3
          gobject-introspection
          agsPackage
        ];

        buildInputs = (mkCoreBuildInputs system) ++ iconsAndFonts;

        installPhase = ''
          mkdir -p $out/bin $out/share/ateon
          
          # Bundle the app
          ags bundle app.ts $out/bin/ateon
          
          # Copy style directory
          if [ -d "style" ]; then
            cp -r style $out/share/ateon/
          fi
          
          # Copy assets directory
          if [ -d "assets" ]; then
            cp -r assets $out/share/ateon/
          fi
          
          # Copy matugen templates directory (note the /templates subdirectory)
          if [ -d "matugen" ]; then
            cp -r matugen $out/share/ateon/
          fi
          
          # Copy configs directory
          if [ -d "configs" ]; then
            cp -r configs $out/share/ateon/
          fi
        '';

        preFixup = ''
          gappsWrapperArgs+=(
            --prefix PATH : ${pkgs.lib.makeBinPath runtimeDeps}
            --prefix XDG_DATA_DIRS : ${pkgs.lib.makeSearchPath "share" iconsAndFonts}
            --set GTK_THEME Adwaita:dark
            --set GDK_PIXBUF_MODULE_FILE ${pkgs.librsvg}/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache
          )
        '';

        meta = with pkgs.lib; {
          description = "Material Design desktop shell for Hyprland";
          homepage = "https://github.com/Youwes09/Ateon-Nix";
          license = licenses.gpl3;
          platforms = platforms.linux;
          maintainers = [];
        };
      };
    in
      pkgs.runCommand "ateon-with-config" {
        nativeBuildInputs = [pkgs.makeWrapper];
      } ''
        mkdir -p $out/bin

        # Copy the bundled app and shared files
        cp -r ${ateon-bundle}/* $out/

        # Create a wrapper script for ateon to copy files on first run
        mv $out/bin/ateon $out/bin/.ateon-unwrapped

        makeWrapper $out/bin/.ateon-unwrapped $out/bin/ateon \
          --run 'ATEON_CONFIG="$HOME/.config/ags"
                 ATEON_SHARE="'"$out"'/share/ateon"
                 
                 # Ensure HOME and XDG directories are set
                 export XDG_CACHE_HOME="''${XDG_CACHE_HOME:-$HOME/.cache}"
                 export XDG_CONFIG_HOME="''${XDG_CONFIG_HOME:-$HOME/.config}"
                 
                 # Create cache directory for MPRIS cover art caching
                 mkdir -p "$XDG_CACHE_HOME"
                 mkdir -p "$ATEON_CONFIG"
                 
                 # Check if SPECIFIC config files exist (not just if directory exists)
                 if [ ! -f "$ATEON_CONFIG/configs/config.json" ] || \
                    [ ! -f "$ATEON_CONFIG/configs/pickerapps.json" ] || \
                    [ ! -d "$ATEON_CONFIG/style" ]; then
                   
                   echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                   echo "  Installing Ateon configuration files..."
                   echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                   
                   # Copy each directory if source exists and destination does not
                   if [ -d "$ATEON_SHARE/style" ] && [ ! -d "$ATEON_CONFIG/style" ]; then
                     echo "→ Installing styles..."
                     cp -r "$ATEON_SHARE/style" "$ATEON_CONFIG/" && echo "  ✓ Styles installed"
                   fi
                   
                   if [ -d "$ATEON_SHARE/assets" ] && [ ! -d "$ATEON_CONFIG/assets" ]; then
                     echo "→ Installing assets..."
                     cp -r "$ATEON_SHARE/assets" "$ATEON_CONFIG/" && echo "  ✓ Assets installed"
                   fi
                   
                   if [ -d "$ATEON_SHARE/matugen" ] && [ ! -d "$ATEON_CONFIG/matugen" ]; then
                     echo "→ Installing matugen templates..."
                     cp -r "$ATEON_SHARE/matugen" "$ATEON_CONFIG/" && echo "  ✓ Matugen templates installed"
                   fi
                   
                   if [ -d "$ATEON_SHARE/configs" ] && [ ! -d "$ATEON_CONFIG/configs" ]; then
                     echo "→ Installing configs..."
                     cp -r "$ATEON_SHARE/configs" "$ATEON_CONFIG/" && echo "  ✓ Configs installed"
                   fi
                   
                   # Make files writable
                   echo "→ Setting permissions..."
                   find "$ATEON_CONFIG" -type d -exec chmod 755 {} \; 2>/dev/null || true
                   find "$ATEON_CONFIG" -type f -exec chmod 644 {} \; 2>/dev/null || true
                   echo "  ✓ Permissions set"
                   
                   echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                   echo "  ✓ Configuration installed to: $ATEON_CONFIG"
                   echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                   echo ""
                 fi'
      '';
  in
    flake-parts.lib.mkFlake {inherit inputs;} {
      systems = import systems;

      perSystem = {system, ...}: let
        pkgs = mkPkgs system;
        agsPackage = ags.packages.${system}.default;

        shellHook = ''
          echo "Setting up Ateon development environment..."

          cat > tsconfig.json << EOF
          {
            "compilerOptions": {
              "allowImportingTsExtensions": true,
              "allowJs": true,
              "baseUrl": ".",
              "experimentalDecorators": false,
              "jsx": "react-jsx",
              "jsxImportSource": "ags/gtk4",
              "module": "ES2022",
              "moduleResolution": "Bundler",
              "noImplicitAny": false,
              "paths": {
                "ags/*": ["${agsPackage}/share/ags/js/lib/*"],
                "ags": ["${agsPackage}/share/ags/js/lib/index.ts"]
              },
              "typeRoots": ["./@girs"],
              "strict": true,
              "target": "ES2020"
            }
          }
          EOF

          if [ ! -d "@girs" ]; then
            ags types -d .
          else
            ags types update -d .
          fi

          echo "Ateon devenv ready! Run 'ags run' to start development."
          echo "Chromash available at: $(which chromash)"
        '';
      in {
        packages.default = mkAteonPackage system;

        apps.default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/ateon";
        };

        devShells.default = pkgs.mkShell {
          buildInputs = 
            (mkCoreBuildInputs system) 
            ++ (mkRuntimeDeps system)
            ++ (mkIconsAndFonts system)
            ++ [agsPackage];
          inherit shellHook;
        };
      };

      flake = {
        homeManagerModules.default = import ./nix/hm-module.nix self;
        nixosModules.default = import ./nix/nixos-module.nix self;
      };
    };
}