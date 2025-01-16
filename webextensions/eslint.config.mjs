import _import from "eslint-plugin-import";
import { fixupPluginRules } from "@eslint/compat";
import babelParser from "@babel/eslint-parser";
import globals from "globals";

const languageOptions = {
  globals: {
    ...globals.browser,
    ...globals.webextensions,
  },

  // This is for a workaround to avoid parsing error around static properties defined in class definitions.
  // See also: https://stackoverflow.com/questions/42701440/eslint-parsing-error-unexpected-token-error-for-assigned-fat-arrow-prop
  parser: babelParser,
  parserOptions: {
    requireConfigFile: false,
  },

  ecmaVersion: 2020,
  sourceType: "module",
};

const rules = {
  "no-const-assign": "error",

  "prefer-const": ["warn", {
      destructuring: "any",
      ignoreReadBeforeAssign: false,
  }],

  "no-var": "error",

  "no-unused-vars": ["warn", {
      vars: "all",
      args: "after-used",
      argsIgnorePattern: "^_",
      caughtErrors: "all",
      caughtErrorsIgnorePattern: "^_",
  }],

  "no-use-before-define": ["error", {
      functions: false,
      classes: true,
  }],

  "no-unused-expressions": "error",
  "no-unused-labels": "error",

  "no-undef": ["error", {
      typeof: true,
  }],

  indent: ["warn", 2, {
      SwitchCase: 1,
      MemberExpression: 1,

      CallExpression: {
          arguments: "first",
      },

      VariableDeclarator: {
          var: 2,
          let: 2,
          const: 3,
      },
  }],

  "no-underscore-dangle": ["warn", {
      allowAfterThis: true,
  }],

  quotes: ["warn", "single", {
      avoidEscape: true,
      allowTemplateLiterals: true,
  }],
};

const ESModuleFiles = [
  "background/*.js",
  "common/*.js",
  "options/*.js",
  "resources/module/*.js",
  "sidebar/*.js",
  "sidebar/components/*.js",
  "tests/*.js",
];

export default [{ // global
    ignores: ["!**/.eslintrc.js", "**/extlib/", "**/eslint.config.mjs", "**/for-module.mjs"],
}, { // regular JS files
    files: ["**/*.js"],
    ignores: [...ESModuleFiles],
    languageOptions,
    rules,
}, { // ES modules
    files: [...ESModuleFiles],

    languageOptions,

    plugins: {
        import: fixupPluginRules(_import),
    },

    settings: {
        "import/resolver": {
            "babel-module": {
                root: ["./"],
            },
        },
    },

    rules: {
        ...rules,

        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/default.md
        "import/default": "error",
        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/namespace.md
        "import/namespace": "error",
        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/no-duplicates.md
        "import/no-duplicates": "error",
        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/export.md
        "import/export": "error",
        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/extensions.md
        "import/extensions": ["error", "always"],
        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/first.md
        "import/first": "error",
        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/named.md
        "import/named": "error",
        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/no-named-as-default.md
        "import/no-named-as-default": "error",
        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/no-named-as-default-member.md
        "import/no-named-as-default-member": "error",
        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/no-cycle.md
        "import/no-cycle": ["warn", {
          // If we comment out this, `maxDepth` is `Infinity`.
          //'maxDepth': 1,
        }],
        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/no-webpack-loader-syntax.md
        "import/no-self-import": "error",
        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/no-unresolved.md
        "import/no-unresolved": ["error", {
            caseSensitive: true,
        }],
        // https://github.com/benmosher/eslint-plugin-import/blob/master/docs/rules/no-useless-path-segments.md
        "import/no-useless-path-segments": "error",
    },
}];
