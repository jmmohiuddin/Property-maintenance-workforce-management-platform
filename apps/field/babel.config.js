// WatermelonDB's models use legacy decorators; the plugin ordering below is
// the combination its documentation requires and is not arbitrary.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: [
      ["@babel/plugin-proposal-decorators", { legacy: true }],
      ["@babel/plugin-transform-class-properties", { loose: true }],
    ],
  };
};
