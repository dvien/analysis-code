import applyMixin from "./mixin";
import devtoolPlugin from "./plugins/devtool";
import ModuleCollection from "./module/module-collection";
import { forEachValue, isObject, isPromise, assert, partial } from "./util";

let Vue; // 绑定安装

export class Store {
  constructor(options = {}) {
    // 判断window.vue是否存在，如果不存在那么就安装
    if (!Vue && typeof window !== "undefined" && window.Vue) {
      install(window.Vue);
    }

    // 开发过程的判断：创建store实例之前必须先使用这个方法Vue.use(Vuex)，并且判断promise是否可用
    if (process.env.NODE_ENV !== "production") {
      // 必须使用 Vue.use(Vuex) 创建 store 实例
      assert(Vue, `must call Vue.use(Vuex) before creating a store instance.`);
      // 因为vuex中使用了Promise，Promise是es6的语法，但是有的浏览器并不支持es6所以我们需要在package.json中加入babel-polyfill用来支持es6
      assert(
        typeof Promise !== "undefined",
        `vuex requires a Promise polyfill in this browser.`
      );
      // Store 函数必须使用 new 操作符调用
      assert(
        this instanceof Store,
        `store must be called with the new operator.`
      );
    }

    // 提取参数
    const {
      /* 插件默认是空数组，包含应用在 store 上的插件方法。这些插件直接接收 store 作为唯一参数，可以监听 mutation（用于外部地数据持久化、记录或调试）或者提交 mutation （用于内部数据，例如 websocket 或 某些观察者）*/
      plugins = [],
      /* 默认是false，使 Vuex store 进入严格模式，在严格模式下，任何 mutation 处理函数以外修改 Vuex state 都会抛出错误。*/
      strict = false
    } = options;

    // 初始化store内部状态
    /* 用来判断严格模式下是否是用mutation修改state的 */
    this._committing = false;
    /* 存放action */
    this._actions = Object.create(null);
    // 用来存储所有对 action 变化的订阅者
    this._actionSubscribers = [];
    /* 存放mutation */
    this._mutations = Object.create(null);
    /* 存放getter */
    this._wrappedGetters = Object.create(null);
    // 模块收集器，构造模块树形结构
    this._modules = new ModuleCollection(options);
    /* 根据namespace存放module */
    this._modulesNamespaceMap = Object.create(null);
    // 用来存储所有对 mutation 变化的订阅者
    this._subscribers = [];
    // 用于使用 $watch 观测 getters
    this._watcherVM = new Vue();
    // 用来存放生成的本地 getters 的缓存
    this._makeLocalGettersCache = Object.create(null);

    /* 将dispatch与commit调用的this绑定为store对象本身，否则在组件内部this.dispatch时的this会指向组件的vm */
    const store = this;
    const { dispatch, commit } = this;
    /* 为dispatch与commit绑定this（Store实例本身） */
    this.dispatch = function boundDispatch(type, payload) {
      return dispatch.call(store, type, payload);
    };
    this.commit = function boundCommit(type, payload, options) {
      return commit.call(store, type, payload, options);
    };

    // 严格模式
    this.strict = strict;

    const state = this._modules.root.state;
    this._wrappedGetters;

    // 初始化根模块，递归注册所有的子模块，收集所有module的getter到_wrappedGetters中去，this._modules.root代表根module才独有保存的Module对象
    installModule(this, state, [], this._modules.root);

    // 通过vm重设store，新建Vue对象使用Vue内部的响应式实现注册state以及computed
    resetStoreVM(this, state);

    // apply plugins
    // 执行每个插件里边的函数
    plugins.forEach(plugin => plugin(this));

    /* devtool插件 */
    const useDevtools =
      options.devtools !== undefined ? options.devtools : Vue.config.devtools;
    if (useDevtools) {
      devtoolPlugin(this);
    }
  }

  get state() {
    return this._vm._data.$$state;
  }

  set state(v) {
    if (process.env.NODE_ENV !== "production") {
      assert(
        false,
        `use store.replaceState() to explicit replace store state.`
      );
    }
  }

  /* 调用mutation的commit方法 */
  commit(_type, _payload, _options) {
    // 校验参数
    // 统一成对象风格
    const { type, payload, options } = unifyObjectStyle(
      _type,
      _payload,
      _options
    );

    const mutation = { type, payload };
    /* 取出type对应的mutation的方法 */
    const entry = this._mutations[type];
    if (!entry) {
      if (process.env.NODE_ENV !== "production") {
        console.error(`[vuex] unknown mutation type: ${type}`);
      }
      return;
    }
    /* 执行mutation中的所有方法 */
    this._withCommit(() => {
      entry.forEach(function commitIterator(handler) {
        handler(payload);
      });
    });
    /* 通知所有订阅者 */
    this._subscribers.forEach(sub => sub(mutation, this.state));

    if (process.env.NODE_ENV !== "production" && options && options.silent) {
      console.warn(
        `[vuex] mutation type: ${type}. Silent option has been removed. ` +
          "Use the filter functionality in the vue-devtools"
      );
    }
  }

  /* 调用action的dispatch方法 */
  dispatch(_type, _payload) {
    // 获取到type和payload参数
    const { type, payload } = unifyObjectStyle(_type, _payload);

    // 声明 action 变量 等于 type和payload参数
    const action = { type, payload };

    /* actions中取出type对应的ation */
    const entry = this._actions[type];
    if (!entry) {
      if (process.env.NODE_ENV !== "production") {
        console.error(`[vuex] unknown action type: ${type}`);
      }
      return;
    }

    try {
      this._actionSubscribers
        .filter(sub => sub.before)
        .forEach(sub => sub.before(action, this.state));
    } catch (e) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[vuex] error in before action subscribers: `);
        console.error(e);
      }
    }

    /* 是数组则包装Promise形成一个新的Promise，只有一个则直接返回第0个 */
    const result =
      entry.length > 1
        ? Promise.all(entry.map(handler => handler(payload)))
        : entry[0](payload);

    return result.then(res => {
      try {
        this._actionSubscribers
          .filter(sub => sub.after)
          .forEach(sub => sub.after(action, this.state));
      } catch (e) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(`[vuex] error in after action subscribers: `);
          console.error(e);
        }
      }
      return res;
    });
  }

  // 订阅 store 的 mutation
  subscribe(fn) {
    return genericSubscribe(fn, this._subscribers);
  }

  // 订阅 store 的 action
  subscribeAction(fn) {
    const subs = typeof fn === "function" ? { before: fn } : fn;
    return genericSubscribe(subs, this._actionSubscribers);
  }

  /**
   * 观测某个值
   * @param {Function} getter 函数
   * @param {Function} cb 回调
   * @param {Object} options 参数对象
   */
  watch(getter, cb, options) {
    if (process.env.NODE_ENV !== "production") {
      assert(
        typeof getter === "function",
        `store.watch only accepts a function.`
      );
    }
    return this._watcherVM.$watch(
      () => getter(this.state, this.getters),
      cb,
      options
    );
  }

  // 替换 store 的根状态，仅用状态合并或时光旅行调试
  replaceState(state) {
    this._withCommit(() => {
      this._vm._data.$$state = state;
    });
  }

  /**
   * 注册一个动态module，当业务进行异步加载的时候，可以通过该接口进行注册动态module
   * @param {Array|String} path 路径
   * @param {Object} rawModule 原始未加工的模块
   * @param {Object} options 参数选项
   */
  registerModule(path, rawModule, options = {}) {
    /* 转化称Array */
    if (typeof path === "string") path = [path];

    if (process.env.NODE_ENV !== "production") {
      assert(Array.isArray(path), `module path must be a string or an Array.`);
      assert(
        path.length > 0,
        "cannot register the root module by using registerModule."
      );
    }

    // 手动调用 模块注册的方法
    this._modules.register(path, rawModule);
    /* 初始化module */
    installModule(
      this,
      this.state,
      path,
      this._modules.get(path),
      options.preserveState
    );
    /* 通过vm重设store，新建Vue对象使用Vue内部的响应式实现注册state以及computed */
    resetStoreVM(this, this.state);
  }

  /**
   * 注销模块
   * @param {Array|String} path 路径
   */
  unregisterModule(path) {
    /* 转化称Array */
    if (typeof path === "string") path = [path];

    if (process.env.NODE_ENV !== "production") {
      assert(Array.isArray(path), `module path must be a string or an Array.`);
    }

    // 手动调用模块注销
    this._modules.unregister(path);
    this._withCommit(() => {
      /* 获取父级的state */
      const parentState = getNestedState(this.state, path.slice(0, -1));
      /* 从父级中删除 */
      Vue.delete(parentState, path[path.length - 1]);
    });
    /* 重制store */
    resetStore(this);
  }

  // 热加载
  hotUpdate(newOptions) {
    // 调用的是 ModuleCollection 的 update 方法，最终调用对应的是每个 Module 的 update
    this._modules.update(newOptions);
    // 重置 Store
    resetStore(this, true);
  }

  /* 调用withCommit修改state的值时会将store的committing值置为true，内部会有断言检查该值，在严格模式下只允许使用mutation来修改store中的值，而不允许直接修改store的数值 */
  _withCommit(fn) {
    const committing = this._committing;
    this._committing = true;
    fn();
    this._committing = committing;
  }
}

/* 收集订阅者:注册一个订阅函数，返回取消订阅的函数 */
function genericSubscribe(fn, subs) {
  if (subs.indexOf(fn) < 0) {
    subs.push(fn);
  }
  return () => {
    const i = subs.indexOf(fn);
    if (i > -1) {
      subs.splice(i, 1);
    }
  };
}

/* 重制store */
function resetStore(store, hot) {
  store._actions = Object.create(null);
  store._mutations = Object.create(null);
  store._wrappedGetters = Object.create(null);
  store._modulesNamespaceMap = Object.create(null);
  const state = store.state;
  // init all modules
  installModule(store, state, [], store._modules.root, true);
  // reset vm
  resetStoreVM(store, state, hot);
}

/* 通过vm重设store，新建Vue对象使用Vue内部的响应式实现注册state以及computed */
function resetStoreVM(store, state, hot) {
  /* 存放之前的vm对象 */
  const oldVm = store._vm;

  // 绑定 store.getter
  store.getters = {};
  // 重置 本地getters的缓存
  store._makeLocalGettersCache = Object.create(null);
  // 注册时收集的处理后的用户自定义的 wrappedGetters
  const wrappedGetters = store._wrappedGetters;
  // 声明 计算属性 computed 对象
  const computed = {};

  /* 通过Object.defineProperty为每一个getter方法设置get方法，比如获取this.$store.getters.test的时候获取的是store._vm.test，也就是Vue对象的computed属性 */
  forEachValue(wrappedGetters, (fn, key) => {
    // use computed to leverage its lazy-caching mechanism
    // direct inline function use will lead to closure preserving oldVm.
    // using partial to return function with only arguments preserved in closure environment.
    computed[key] = partial(fn, store);
    Object.defineProperty(store.getters, key, {
      get: () => store._vm[key],
      enumerable: true // for local getters
    });
  });

  // 使用一个 Vue 实例对象存储 state 树
  // 阻止警告 用户添加的一些全局mixins
  // 声明变量 silent 存储用户设置的静默模式配置
  const silent = Vue.config.silent;
  /* Vue.config.silent暂时设置为true的目的是在new一个Vue实例的过程中不会报出一切警告 */
  Vue.config.silent = true;
  /*  这里new了一个Vue对象，运用Vue内部的响应式实现注册state以及computed */
  store._vm = new Vue({
    data: {
      $$state: state
    },
    computed
  });
  Vue.config.silent = silent;

  /* 使能严格模式，保证修改store只能通过mutation */
  if (store.strict) {
    enableStrictMode(store);
  }

  if (oldVm) {
    /* 解除旧vm的state的引用，以及销毁旧的Vue对象 */
    if (hot) {
      // 热加载为 true
      // 设置  oldVm._data.$$state = null
      store._withCommit(() => {
        oldVm._data.$$state = null;
      });
    }
    // 实例销毁
    Vue.nextTick(() => oldVm.$destroy());
  }
}

/* 初始化module */
/* @store: 表示当前Store实例
/* @rootState: 表示根state
/* @path: 我们可以将一个store实例看成module的集合。每一个集合也是store的实例。那么path就可以想象成一种层级关系，当你有了rootState和path后，就可以在Path路径中找到local State。然后每次getters或者setters改变的就是localState
/* @module:表示当前安装的模块
/* @hot：当动态改变modules或者热更新的时候为true */
function installModule(store, rootState, path, module, hot) {
  /* 是否是根module */
  const isRoot = !path.length;
  /* 获取module的namespace */
  const namespace = store._modules.getNamespace(path);

  /* 如果有namespace，检查是否重复，不重复则在_modulesNamespaceMap中注册 */
  if (module.namespaced) {
    if (
      store._modulesNamespaceMap[namespace] &&
      process.env.NODE_ENV !== "production"
    ) {
      console.error(
        `[vuex] duplicate namespace ${namespace} for the namespaced module ${path.join(
          "/"
        )}`
      );
    }
    store._modulesNamespaceMap[namespace] = module;
  }

  // 注册state
  // 如果不是根并且不是热重载的情况
  if (!isRoot && !hot) {
    /* 获取父级的state */
    const parentState = getNestedState(rootState, path.slice(0, -1));
    // 模块名称
    const moduleName = path[path.length - 1];

    // state 注册
    store._withCommit(() => {
      if (process.env.NODE_ENV !== "production") {
        // 有相同的模块名会报错
        if (moduleName in parentState) {
          console.warn(
            `[vuex] state field "${moduleName}" was overridden by a module with the same name at "${path.join(
              "."
            )}"`
          );
        }
      }
      /* 将子module设置称响应式的 */
      Vue.set(parentState, moduleName, module.state);
    });
  }

  /**
   * module.context 这个赋值主要是给 helpers 中 mapState、mapGetters、mapMutations、mapActions四个辅助函数使用的。
   * 生成本地的dispatch、commit、getters和state。
   * 主要作用就是抹平差异化，不需要用户再传模块参数。
   */
  const local = (module.context = makeLocalContext(store, namespace, path));

  /* 遍历注册mutation */
  module.forEachMutation((mutation, key) => {
    const namespacedType = namespace + key;
    registerMutation(store, namespacedType, mutation, local);
  });

  /* 遍历注册action */
  module.forEachAction((action, key) => {
    const type = action.root ? key : namespace + key;
    const handler = action.handler || action;
    registerAction(store, type, handler, local);
  });

  /* 遍历注册getter */
  module.forEachGetter((getter, key) => {
    const namespacedType = namespace + key;
    registerGetter(store, namespacedType, getter, local);
  });

  /* 递归安装mudule */
  module.forEachChild((child, key) => {
    installModule(store, rootState, path.concat(key), child, hot);
  });
}

/**
 * make localized dispatch, commit, getters and state
 * if there is no namespace, just use root ones
 */
function makeLocalContext(store, namespace, path) {
  const noNamespace = namespace === "";

  const local = {
    dispatch: noNamespace
      ? store.dispatch
      : (_type, _payload, _options) => {
          const args = unifyObjectStyle(_type, _payload, _options);
          const { payload, options } = args;
          let { type } = args;

          if (!options || !options.root) {
            type = namespace + type;
            if (
              process.env.NODE_ENV !== "production" &&
              !store._actions[type]
            ) {
              console.error(
                `[vuex] unknown local action type: ${args.type}, global type: ${type}`
              );
              return;
            }
          }

          return store.dispatch(type, payload);
        },

    commit: noNamespace
      ? store.commit
      : (_type, _payload, _options) => {
          const args = unifyObjectStyle(_type, _payload, _options);
          const { payload, options } = args;
          let { type } = args;

          if (!options || !options.root) {
            type = namespace + type;
            if (
              process.env.NODE_ENV !== "production" &&
              !store._mutations[type]
            ) {
              console.error(
                `[vuex] unknown local mutation type: ${args.type}, global type: ${type}`
              );
              return;
            }
          }

          store.commit(type, payload, options);
        }
  };

  // getters and state object must be gotten lazily
  // because they will be changed by vm update
  Object.defineProperties(local, {
    getters: {
      get: noNamespace
        ? () => store.getters
        : () => makeLocalGetters(store, namespace)
    },
    state: {
      get: () => getNestedState(store.state, path)
    }
  });

  return local;
}

function makeLocalGetters(store, namespace) {
  if (!store._makeLocalGettersCache[namespace]) {
    const gettersProxy = {};
    const splitPos = namespace.length;
    Object.keys(store.getters).forEach(type => {
      // skip if the target getter is not match this namespace
      if (type.slice(0, splitPos) !== namespace) return;

      // extract local getter type
      const localType = type.slice(splitPos);

      // Add a port to the getters proxy.
      // Define as getter property because
      // we do not want to evaluate the getters in this time.
      Object.defineProperty(gettersProxy, localType, {
        get: () => store.getters[type],
        enumerable: true
      });
    });
    store._makeLocalGettersCache[namespace] = gettersProxy;
  }

  return store._makeLocalGettersCache[namespace];
}

/**
 * 注册 mutation
 * @param {Object} store 对象
 * @param {String} type 类型
 * @param {Function} handler 用户自定义的函数
 * @param {Object} local local 对象
 */
function registerMutation(store, type, handler, local) {
  // 收集的所有的mutations找对应的mutation函数，没有就赋值空数组
  const entry = store._mutations[type] || (store._mutations[type] = []);
  // 最后 mutation
  entry.push(function wrappedMutationHandler(payload) {
    /**
     * mutations: {
     *    pushProductToCart (state, { id }) {
     *        console.log(state);
     *    }
     * }
     * 也就是为什么用户定义的 mutation 第一个参数是state的原因，第二个参数是payload参数
     */
    handler.call(store, local.state, payload);
  });
}

/**
 * 注册 mutation
 * @param {Object} store 对象
 * @param {String} type 类型
 * @param {Function} handler 用户自定义的函数
 * @param {Object} local local 对象
 */
function registerAction(store, type, handler, local) {
  /* 取出type对应的action */
  const entry = store._actions[type] || (store._actions[type] = []);
  // payload 是actions函数的第二个参数
  entry.push(function wrappedActionHandler(payload) {
    /**
     * 也就是为什么用户定义的actions中的函数第一个参数有
     *  { dispatch, commit, getters, state, rootGetters, rootState } 的原因
     * actions: {
     *    checkout ({ commit, state }, products) {
     *        console.log(commit, state);
     *    }
     * }
     */
    let res = handler.call(
      store,
      {
        dispatch: local.dispatch,
        commit: local.commit,
        getters: local.getters,
        state: local.state,
        rootGetters: store.getters,
        rootState: store.state
      },
      payload
    );
    /* 判断是否是Promise */
    /**
     * export function isPromise (val) {
        return val && typeof val.then === 'function'
      }
     * 判断如果不是Promise Promise 化，也就是为啥 actions 中处理异步函数
        也就是为什么构造函数中断言不支持promise报错的原因
        vuex需要Promise polyfill
        assert(typeof Promise !== 'undefined', `vuex requires a Promise polyfill in this browser.`)
     */
    if (!isPromise(res)) {
      /* 不是Promise对象的时候转化称Promise对象 */
      res = Promise.resolve(res);
    }
    // devtool 工具触发 vuex:error
    if (store._devtoolHook) {
      // catch 捕获错误
      return res.catch(err => {
        store._devtoolHook.emit("vuex:error", err);
        // 抛出错误
        throw err;
      });
    } else {
      // 然后函数执行结果
      return res;
    }
  });
}

/**
 * 注册 getter
 * @param {Object} store  Store实例
 * @param {String} type 类型
 * @param {Object} rawGetter  原始未加工的 getter 也就是用户定义的 getter 函数
 * @examples  比如 cartProducts: (state, getters, rootState, rootGetters) => {}
 * @param {Object} local 本地 local 对象
 */
function registerGetter(store, type, rawGetter, local) {
  // 类型如果已经存在，报错：已经存在
  if (store._wrappedGetters[type]) {
    if (process.env.NODE_ENV !== "production") {
      console.error(`[vuex] duplicate getter key: ${type}`);
    }
    return;
  }
  // 否则：赋值
  store._wrappedGetters[type] = function wrappedGetter(store) {
    /**
     * 这也就是为啥 getters 中能获取到  (state, getters, rootState, rootGetters)  这些值的原因
     * getters = {
     *      cartProducts: (state, getters, rootState, rootGetters) => {
     *        console.log(state, getters, rootState, rootGetters);
     *      }
     * }
     */
    return rawGetter(
      local.state, // local state
      local.getters, // local getters
      store.state, // root state
      store.getters // root getters
    );
  };
}

/* 使用严格模式 */
function enableStrictMode(store) {
  store._vm.$watch(
    function() {
      return this._data.$$state;
    },
    () => {
      if (process.env.NODE_ENV !== "production") {
        /* 检测store中的_committing的值，如果是false代表不是通过mutation的方法修改的 */
        assert(
          store._committing,
          `do not mutate vuex store state outside mutation handlers.`
        );
      }
    },
    { deep: true, sync: true }
  );
}

/* 获取父级的state */
function getNestedState(state, path) {
  return path.reduce((state, key) => state[key], state);
}
// 统一成对象风格
function unifyObjectStyle(type, payload, options) {
  if (isObject(type) && type.type) {
    options = payload;
    payload = type;
    type = type.type;
  }

  if (process.env.NODE_ENV !== "production") {
    assert(
      typeof type === "string",
      `expects string as the type, but found ${typeof type}.`
    );
  }

  return { type, payload, options };
}

/* 暴露给外部的插件install方法，供Vue.use调用安装插件 */
/* 当window上有Vue对象的时候，就会手动编写install方法，并且传入Vue的使用。*/
export function install(_Vue) {
  if (Vue && _Vue === Vue) {
    /* 避免重复安装（Vue.use内部也会检测一次是否重复安装同一个插件）*/
    if (process.env.NODE_ENV !== "production") {
      console.error(
        "[vuex] already installed. Vue.use(Vuex) should be called only once."
      );
    }
    return;
  }
  /* 保存Vue，同时用于检测是否重复安装 */
  Vue = _Vue;

  /* 将vuexInit混淆进Vue的beforeCreate(Vue2.0)或_init方法(Vue1.0) */
  /* vueInit 是对vuex的初始化，把$store属性添加到vue实例上，所以我们平常写代码可以使用this.$store，这里的store就是我们实例化Vue的时候传进去的store */
  applyMixin(Vue);
}
