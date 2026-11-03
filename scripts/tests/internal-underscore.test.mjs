import { describe, it } from "node:test";
import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "eslint";
import rule from "../../eslint-rules/internal-underscore.js";

RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({ languageOptions: { parser: tsParser } });

ruleTester.run("internal-underscore", rule, {
  valid: [
    {
      name: "an @internal overload of a public method",
      code: `class Meta {
        public on(event: string): this;
        /** @internal */
        public on(event: string, options: object): this;
        public on(event: string, options?: object): this {
          return this;
        }
      }`,
    },
    {
      name: "an @internal underscore implementation",
      code: `class Meta {
        /** @internal */
        public _install(): void {}
      }`,
    },
    {
      name: "a private underscore member",
      code: `class Meta {
        private _count = 0;
      }`,
    },
  ],
  invalid: [
    {
      name: "an @internal implementation without an underscore",
      code: `class Meta {
        /** @internal */
        public install(): void {}
      }`,
      errors: [{ messageId: "requireUnderscore", data: { name: "install", reason: "@internal" } }],
    },
    {
      name: "a private member without an underscore",
      code: `class Meta {
        private count = 0;
      }`,
      errors: [{ messageId: "requireUnderscore", data: { name: "count", reason: "private" } }],
    },
    {
      name: "a public underscore member that is not @internal",
      code: `class Meta {
        public _install(): void {}
      }`,
      errors: [{ messageId: "forbidUnderscore", data: { name: "_install" } }],
    },
  ],
});
