import Vue from "vue";
import Vuex from "vuex";

Vue.use(Vuex);

const moduleA = {
  namespaced: true,
  state: { count: 1 },
  mutations: {
    add(state) {
      state.count = state.count + 1;
    },
    reduction(state) {
      state.count = state.count - 1;
    }
  }
  // mutations: { ... },
  // actions: { ... },
  // getters: { ... }
};

const moduleB = {
  state: { count: 1 },
  mutations: {
    add(state) {
      state.count = state.count + 1;
    },
    reduction(state) {
      state.count = state.count - 1;
    }
  }
  // mutations: { ... },
  // actions: { ... }
};

const store = new Vuex.Store({
  // strict: true,
  state: {
    count: 1
  },
  getters: {
    getStateCount(state) {
      return state.count + 1;
    }
  },
  mutations: {
    add(state) {
      // state.count = state.count + 1;
      new Promise(resolve => {
        setTimeout(() => (state.count = state.count + 1), 3000);
      });
    },
    reduction(state) {
      state.count = state.count - 1;
    }
  },
  actions: {
    addFun(context) {
      context.commit("add");
    },
    reductionFun(context) {
      context.commit("reduction");
    }
  },
  modules: { a: moduleA, b: moduleB }
});
window.store = store;
export default store;
