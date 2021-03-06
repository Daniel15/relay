/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict-local
 * @format
 * @emails oncall+relay
 */

'use strict';

const PreloadableQueryRegistry = require('./PreloadableQueryRegistry');
const React = require('react');

const invariant = require('invariant');

const {
  ReplaySubject,
  createOperationDescriptor,
  getRequest,
  Observable,
} = require('relay-runtime');

import type {
  PreloadableConcreteRequest,
  PreloadedQueryInner,
  LoadQueryOptions,
} from './EntryPointTypes.flow';
import type {
  IEnvironment,
  OperationType,
  GraphQLTaggedNode,
  GraphQLResponse,
} from 'relay-runtime';

const LOAD_QUERY_AST_MAX_TIMEOUT = 30 * 1000;

let RenderDispatcher = null;

function useTrackLoadQueryInRender() {
  if (RenderDispatcher === null) {
    // Flow does not know of React internals (rightly so), but we need to
    // ensure here that this function isn't called inside render.
    RenderDispatcher =
      // $FlowFixMe
      React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
        ?.ReactCurrentDispatcher?.current;
  }
}

function loadQuery<TQuery: OperationType>(
  environment: IEnvironment,
  preloadableRequest: GraphQLTaggedNode | PreloadableConcreteRequest<TQuery>,
  variables: $ElementType<TQuery, 'variables'>,
  options?: LoadQueryOptions,
): PreloadedQueryInner<TQuery> {
  // Flow does not know of React internals (rightly so), but we need to
  // ensure here that this function isn't called inside render.
  const CurrentDispatcher =
    // $FlowFixMe
    React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
      ?.ReactCurrentDispatcher?.current;
  invariant(
    RenderDispatcher == null || CurrentDispatcher !== RenderDispatcher,
    'Relay: `preloadQuery` (or `prepareEntryPoint`) should not be called inside a React render function.',
  );

  const fetchPolicy = options?.fetchPolicy ?? 'store-or-network';

  let madeNetworkRequest = false;
  const makeNetworkRequest = (params): Observable<GraphQLResponse> => {
    // N.B. this function is called synchronously or not at all
    // madeNetworkRequest is safe to rely on in the returned value

    madeNetworkRequest = true;
    const network = environment.getNetwork();
    const sourceObservable = network.execute(params, variables, {
      force: true,
      ...options?.networkCacheConfig,
    });

    const subject = new ReplaySubject();
    sourceObservable.subscribe({
      error(err) {
        subject.error(err);
      },
      next(data) {
        subject.next(data);
      },
      complete() {
        subject.complete();
      },
    });
    return Observable.create(sink => subject.subscribe(sink));
  };

  const normalizationSubject = new ReplaySubject();
  const returnedObservable = Observable.create(sink =>
    normalizationSubject.subscribe(sink),
  );

  let unsubscribeFromExecute;
  let retainReference;
  const executeWithSource = (operation, sourceObservable) => {
    retainReference = environment.retain(operation);
    ({unsubscribe: unsubscribeFromExecute} = environment
      .executeWithSource({
        operation,
        source: sourceObservable,
      })
      .subscribe({
        error(err) {
          normalizationSubject.error(err);
        },
        next(data) {
          normalizationSubject.next(data);
        },
        complete() {
          normalizationSubject.complete();
        },
      }));
  };

  const checkAvailabilityAndExecute = concreteRequest => {
    const operation = createOperationDescriptor(concreteRequest, variables);
    const shouldFetch =
      fetchPolicy !== 'store-or-network' ||
      environment.check(operation).status !== 'available';

    if (shouldFetch) {
      const source = makeNetworkRequest(concreteRequest.params);
      executeWithSource(operation, source);
    }
    // if the fetch policy allows fulfillment from the store and the environment
    // has the appropriate data, we do nothing.
  };

  let params;
  let loadQueryAstTimeoutId;
  let cancelOnLoadCallback;
  let moduleId;
  if (preloadableRequest.kind === 'PreloadableConcreteRequest') {
    const preloadableConcreteRequest: PreloadableConcreteRequest<TQuery> = (preloadableRequest: $FlowFixMe);
    ({params} = preloadableConcreteRequest);

    ({id: moduleId} = params);
    invariant(
      moduleId !== null,
      'Relay: `loadQuery` requires that preloadable query `%s` has a persisted query id',
      params.name,
    );

    const module = PreloadableQueryRegistry.get(moduleId);

    if (module != null) {
      checkAvailabilityAndExecute(module);
    } else {
      // If the module isn't synchronously available, we launch the network request
      // immediately and ignore the fetch policy.
      const source = makeNetworkRequest(params);
      ({dispose: cancelOnLoadCallback} = PreloadableQueryRegistry.onLoad(
        moduleId,
        preloadedModule => {
          clearTimeout(loadQueryAstTimeoutId);
          cancelOnLoadCallback();
          const operation = createOperationDescriptor(
            preloadedModule,
            variables,
          );
          executeWithSource(operation, source);
        },
      ));
      loadQueryAstTimeoutId = setTimeout(() => {
        cancelOnLoadCallback();
        const onError = options?.onQueryAstLoadTimeout;
        const error = new Error(
          `Relay: Query AST did not load in time for preloadable query ${params.name}`,
        );
        if (onError) {
          onError(error);
        } else {
          throw error;
        }
      }, LOAD_QUERY_AST_MAX_TIMEOUT);
    }
  } else {
    const graphQlTaggedNode: GraphQLTaggedNode = (preloadableRequest: $FlowFixMe);
    const request = getRequest(graphQlTaggedNode);
    params = request.params;

    ({id: moduleId} = params);
    invariant(
      moduleId !== null,
      'Relay: `loadQuery` requires that preloadable query `%s` has a persisted query id',
      params.name,
    );

    checkAvailabilityAndExecute(request);
  }

  return {
    kind: 'PreloadedQuery',
    environment,
    dispose: () => {
      unsubscribeFromExecute && unsubscribeFromExecute();
      retainReference && retainReference.dispose();
      cancelOnLoadCallback && cancelOnLoadCallback();
      loadQueryAstTimeoutId != null && clearTimeout(loadQueryAstTimeoutId);
    },
    id: moduleId,
    name: params.name,
    fetchPolicy,
    source: madeNetworkRequest ? returnedObservable : undefined,
    variables,
  };
}

module.exports = {loadQuery, useTrackLoadQueryInRender};
